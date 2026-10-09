import { workflowToolName } from "./workflow/catalog.mjs";
import { snippetDisplay } from "./workflow/snippet-result.mjs";
import { visibleAssistantText } from "./assistant-text.mjs";
import { normalizeClarification } from "./desktop-questionnaire.mjs";
import { openingDeferral } from "./assistant-opening-hook.mjs";
const presentationToolName = name => name === "clarify_user" ? "AskUserQuestion" : /(?:^|__)node_repl__js$/.test(name??"") ? "mcp__node_repl__js" : workflowToolName(name);
function presentationToolInput(name, input) {
  if (name !== "clarify_user") return input;
  try { return { questions: normalizeClarification(input) }; }
  catch { return input; } // 不完整或无效参数仍显示原值，不能让展示层打断真实工具错误。
}
/** Step 原生事件 → v4 行增量。只展示后端实际发送的内容，不补造思考或工具过程。 */
export class StepStreamProjection {
  constructor(rows, turnId, model) {
    this.rows = rows;
    this.turnId = turnId;
    this.model = model;
    this.blocks = new Map();
    this.tools = new Map();
    this.response = 0;
    this.outcome = "completedSuccess";
    this.rawTexts = new Map();
  }

  emitRow(row, fresh = false) {
    this.deltas.push({ op: fresh ? "row.appended" : "row.upserted", row: structuredClone(row) });
  }

  newRow(fields) {
    const rowId = (this.rows.at(-1)?.rowId ?? 0) + 1;
    const row = { rowId, turnId: this.turnId, createdAt: Date.now(), createdAtSeq: rowId,
      assistantResponseId: `${this.turnId}-response-${this.response}`, ...fields };
    this.rows.push(row);
    this.emitRow(row, true);
    return row;
  }

  block(index, kind, partial) {
    let row = this.blocks.get(index);
    if (row) return row;
    if (kind === "toolCall") {
      const id = partial?.id ?? `${this.turnId}-${this.response}-${index}`;
      row = this.tools.get(id) ?? this.newRow({ kind, toolCallId: id, toolName: presentationToolName(partial?.name) ?? "tool", inputText: "", status: "inputStreaming" });
      this.tools.set(id, row);
    } else {
      row = this.newRow({ kind, text: "", state: "streaming", ...(kind === "assistantText" ? { model: this.model } : {}) });
    }
    this.blocks.set(index, row);
    return row;
  }

  append(row, path, value) {
    if (!value) return;
    if (row.kind === "assistantText" && path === "text") {
      const raw = (this.rawTexts.get(row.rowId) ?? "") + value;
      this.rawTexts.set(row.rowId, raw);
      const next = visibleAssistantText(raw, {streaming:true});
      if (next.startsWith(row.text)) {
        const append=next.slice(row.text.length);row.text=next;
        if(append)this.deltas.push({op:"row.delta",rowId:row.rowId,path,append});
      } else { row.text=next;this.emitRow(row); }
      return;
    }
    row[path] += value;
    this.deltas.push({ op: "row.delta", rowId: row.rowId, path, append: value });
  }

  finishBlock(row, part, interrupted = false, stripProtocol = true) {
    if (row.kind === "toolCall") {
      row.toolCallId = part?.id ?? row.toolCallId;
      row.toolName = presentationToolName(part?.name) ?? row.toolName;
      if (part?.arguments !== undefined) { row.input = presentationToolInput(part?.name, part.arguments); row.inputText = JSON.stringify(row.input); }
      if (row.status === "inputStreaming") row.status = interrupted ? "cancelled" : "running";
      this.tools.set(row.toolCallId, row);
    } else {
      const text = row.kind === "reasoning" ? part?.thinking : part?.text;
      if (typeof text === "string") row.text = row.kind === "assistantText" ? visibleAssistantText(text,{strip:stripProtocol}) : text;
      row.state = interrupted ? "interrupted" : "complete";
      if (row.kind === "reasoning") row.durationMs = Date.now() - row.createdAt;
    }
    this.emitRow(row);
  }

  handle(event) {
    this.deltas = [];
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.blocks.clear();
      this.response++;
      this.outcome = "completedSuccess";
      this.model = event.message.model ?? this.model;
    }
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent;
      if (!inner) return this.deltas;
      const index = inner.contentIndex ?? 0;
      const part = inner.partial?.content?.[index];
      const kind = inner.type.startsWith("thinking_") ? "reasoning" : inner.type.startsWith("toolcall_") ? "toolCall" : inner.type.startsWith("text_") ? "assistantText" : null;
      if (!kind) return this.deltas;
      const row = this.block(index, kind, part ?? { id: inner.id, name: inner.toolName });
      if (inner.type.endsWith("_delta")) this.append(row, kind === "toolCall" ? "inputText" : "text", inner.delta);
      if (inner.type.endsWith("_end")) this.finishBlock(row, inner.toolCall ?? part ?? (kind === "reasoning" ? { thinking: inner.content } : { text: inner.content }));
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      const interrupted = message.stopReason === "aborted" || message.stopReason === "error";
      if (interrupted) this.outcome = message.stopReason === "aborted" ? "completedInterrupted" : "failed";
      for (const [index, part] of (message.content ?? []).entries()) {
        const kind = part.type === "thinking" ? "reasoning" : part.type === "text" ? "assistantText" : part.type === "toolCall" ? "toolCall" : null;
        if (kind) this.finishBlock(this.block(index, kind, part), part, interrupted, message.content.some(p=>p.type==="toolCall"));
      }
      if (message.errorMessage) {
        const row = this.newRow({ kind: "assistantText", text: message.errorMessage, state: "failed", model: this.model });
        this.emitRow(row);
      }
    }
    if (event.type.startsWith("tool_execution_")) {
      const id = event.toolCallId;
      let row = this.tools.get(id);
      if (!row) {
        row = this.newRow({ kind: "toolCall", toolCallId: id, toolName: presentationToolName(event.toolName) ?? "tool", inputText: JSON.stringify(event.args ?? {}), status: "running" });
        this.tools.set(id, row);
      }
      if (event.args !== undefined) { row.input = presentationToolInput(event.toolName, event.args); row.inputText = JSON.stringify(row.input); }
      if (event.type === "tool_execution_start") row.status = "running";
      // 工具状态由工具行展示，不能伪造 assistant 进度或反复覆盖较早的消息。
      if (event.type === "tool_execution_update") {
        row.output = { text: resultText(event.partialResult) };
        row.status = "running";
      }
      if (event.type === "tool_execution_end") {
        delete row.interactionId;
        row.output = { text: resultText(event.result) };
        row.status = event.isError ? "error" : "success";
        const display = snippetDisplay(row.toolName, row.output.text);
        if (display) row.display = display;
        const deferred = event.isError ? openingDeferral(event.result) : null;
        if (deferred) { row.status = "cancelled"; row.output = { text: deferred }; }
        if (deferred?.includes("本轮已停止") && this.outcome !== "failed") {
          this.outcome = "failed";
          this.newRow({ kind: "assistantText", text: deferred, state: "failed" });
        }
        if (event.toolName === "clarify_user" && event.result?.details?.cancelled === true) row.status = "cancelled";
        if (event.isError && !deferred) row.error = { code: "step_tool_error", message: row.output.text || "工具执行失败" };
      }
      this.emitRow(row);
    }
    if (event.type === "step_client_failed" && event.errorMessage && this.outcome !== "completedInterrupted") this.newRow({ kind: "assistantText", text: event.errorMessage, state: "failed", model: this.model });
    if (event.type === "agent_settled" || event.type === "step_client_failed") {
      for (const row of this.rows) {
        if (row.turnId !== this.turnId) continue;
        if (row.state === "streaming") { row.state = this.outcome === "completedSuccess" ? "complete" : "interrupted"; this.emitRow(row); }
        if (row.kind === "toolCall" && ["running", "inputStreaming", "pendingApproval"].includes(row.status)) { row.status = "cancelled"; delete row.interactionId; this.emitRow(row); }
      }
    }
    return this.deltas;
  }
}

function resultText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.text === "string") return result.text;
  if (Array.isArray(result?.content)) return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  return result == null ? "" : JSON.stringify(result);
}
