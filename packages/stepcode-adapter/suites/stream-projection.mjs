import { test } from "node:test";
import assert from "node:assert/strict";
import { StepStreamProjection } from "../src/stream-projection.mjs";
import { createProjection } from "../src/bridge/projection.mjs";
import { InputLedger } from "../src/input-admission.mjs";

test("stream: thinking and text arrive before completion, separate responses stay separate", () => {
  const rows = [], projection = new StepStreamProjection(rows, "turn", "step-5");
  const send = (type, contentIndex, extra = {}) => projection.handle({ type: "message_update", assistantMessageEvent: { type, contentIndex, ...extra } });
  projection.handle({ type: "message_start", message: { role: "assistant" } });
  const thought = send("thinking_delta", 0, { delta: "Checking" });
  assert.equal(thought[0].row.kind, "reasoning");
  assert.equal(thought[1].append, "Checking");
  assert.equal(rows[0].state, "streaming");
  send("thinking_end", 0, { content: "Checking" });
  send("text_delta", 1, { delta: "First" });
  projection.handle({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Checking" }, { type: "text", text: "First" }] } });
  projection.handle({ type: "message_start", message: { role: "assistant" } });
  send("text_delta", 0, { delta: "Second" });
  projection.handle({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Second" }] } });
  assert.deepEqual(rows.map(row => row.text), ["Checking", "First", "Second"]);
  assert.equal(new Set(rows.map(row => row.rowId)).size, 3);
  assert.notEqual(rows[1].assistantResponseId, rows[2].assistantResponseId);
});

test("stream: tool arguments, live output and truthful terminal errors keep one row", () => {
  const rows = [], projection = new StepStreamProjection(rows, "turn", "step-5");
  projection.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [{ id: "tool-1", name: "bash" }] } } });
  projection.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"echo"}' } });
  projection.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "tool-1", name: "bash", arguments: { command: "echo" } } } });
  projection.handle({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "echo" } });
  const update = projection.handle({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { content: [{ type: "text", text: "live output" }] } });
  assert.equal(update[0].row.status, "running");
  assert.equal(update[0].row.output.text, "live output");
  projection.handle({ type: "tool_execution_end", toolCallId: "tool-1", result: { content: [{ type: "text", text: "failed output" }] }, isError: true });
  assert.equal(rows.filter(row=>row.kind === "toolCall").length, 1);
  assert.equal(rows[0].status, "error");
  assert.equal(rows[0].error.message, "failed output");
});

test("stream: abort preserves partial text and marks interruption", () => {
  const rows = [], projection = new StepStreamProjection(rows, "turn", "step-5");
  projection.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Partial" } });
  projection.handle({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "Partial" }] } });
  projection.handle({ type: "agent_settled" });
  assert.equal(rows[0].text, "Partial");
  assert.equal(rows[0].state, "interrupted");
  assert.equal(projection.outcome, "completedInterrupted");
});

for (const [stopReason, outcome, resultType] of [["error", "failed", "error_during_execution"], ["aborted", "completedInterrupted", "cancelled"], ["stop", "completedSuccess", "success"]]) {
  test(`stream: legacy ${stopReason} terminal agrees with V4 outcome`, () => {
    const frames = [], ctx = {
      primarySession: { sessionId: "terminal", modelSelection: { providerId: "unknown-provider", modelId: "unknown-model" } },
      conversationRows: [], ledger: new InputLedger(), sessionStatistics: () => ({ handle: () => false }),
      v4Subscriptions: new Map(), workflowBridge: {}, persistPrimarySummary() {}, broadcastSessionsIndexUpsert() {}, scheduleQueueDrain() {}, runInputOperation: async fn => fn(),
      notify: (method, payload) => frames.push({ method, payload }), streamingText: "", eventSeq: 0, stateRevision: 0,
    };
    ctx.ledger.begin({ commandId: "terminal-input", text: "fixture", busy: false });
    ctx.ledger.markSubmitted("terminal-input");
    const projection = createProjection(ctx);
    projection.projectStepEvent({ type: "agent_start" });
    projection.projectStepEvent({ type: "message_start", message: { role: "assistant" } });
    projection.projectStepEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason, errorMessage: "fixture" } });
    projection.projectStepEvent({ type: "agent_settled" });
    assert.equal(ctx.streamProjection.outcome, outcome);
    assert.equal(ctx.conversationRows.find(row => row.kind === "turnHeader").state, outcome);
    assert.equal(frames.find(frame => frame.payload.type === "turn.completed").payload.payload.resultType, resultType);
  });
}

test("stream: process failure settles only the current live turn, keeps pending queue and stops partial rows", () => {
  const frames = [], ctx = {
    primarySession: { sessionId: "exit", modelSelection: { providerId: "fixture", modelId: "model" } },
    conversationRows: [], ledger: new InputLedger(), sessionStatistics: () => ({ handle: () => false }),
    v4Subscriptions: new Map(), workflowBridge: {}, persistPrimarySummary() {}, broadcastSessionsIndexUpsert() {}, scheduleQueueDrain() {}, runInputOperation: async fn => fn(),
    notify: (method, payload) => frames.push({ method, payload }), streamingText: "", eventSeq: 0, stateRevision: 0,
  };
  const projection = createProjection(ctx);
  ctx.ledger.begin({ commandId: "active", text: "active", busy: false }); ctx.ledger.markSubmitted("active");
  projection.projectStepEvent({ type: "agent_start" });
  projection.projectStepEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } });
  const queued = ctx.ledger.begin({ commandId: "queue", text: "keep", busy: true }); queued.managed = true; ctx.ledger.markQueued("queue");
  const turnId = ctx.currentTurnId;
  projection.projectStepEvent({ type: "step_client_failed", turnId: "stale-run", errorMessage: "ignored" });
  assert.equal(ctx.turnBusy, true); assert.equal(ctx.ledger.frozen, false);
  projection.projectStepEvent({ type: "step_client_failed", turnId, errorMessage: "process exited" });
  assert.equal(ctx.turnBusy, false); assert.equal(ctx.ledger.frozen, true); assert.equal(queued.state, "queued");
  assert.equal(ctx.conversationRows.find(row => row.text === "partial").state, "interrupted");
  assert.equal(ctx.conversationRows.find(row => row.text === "process exited").state, "failed");
  assert.equal(frames.filter(frame => frame.payload.type === "turn.completed").length, 1);
  projection.projectStepEvent({ type: "step_client_failed", turnId, errorMessage: "duplicate" });
  ctx.turnBusy = true;
  projection.projectStepEvent({ type: "step_client_failed", turnId: null, errorMessage: "before-start" });
  assert.equal(ctx.turnBusy, false); assert.equal(queued.state, "queued");
  assert.equal(frames.filter(frame => frame.payload.type === "turn.completed").length, 1, "不能重复结束上一轮");
});

for (const finalReason of ["stop", "error", "aborted"]) test(`stream: repeated native starts before settled keep one logical user turn (${finalReason})`, () => {
  const frames = [], ctx = {
    primarySession: { sessionId: "retry", modelSelection: { providerId: "fixture", modelId: "model" } },
    conversationRows: [], ledger: new InputLedger(), sessionStatistics: () => ({ handle: () => false }),
    v4Subscriptions: new Map(), workflowBridge: {}, persistPrimarySummary() {}, broadcastSessionsIndexUpsert() {}, scheduleQueueDrain() {}, runInputOperation: async fn => fn(),
    notify: (method, payload) => frames.push({ method, payload }), streamingText: "", eventSeq: 0, stateRevision: 0,
  };
  ctx.ledger.begin({ commandId: "original-input", text: "retry safely", busy: false }); ctx.ledger.markSubmitted("original-input");
  const projection = createProjection(ctx);
  projection.projectStepEvent({ type: "agent_start" }); const id = ctx.currentTurnId;
  projection.projectStepEvent({ type: "message_start", message: { role: "assistant" } });
  projection.projectStepEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503" } });
  projection.projectStepEvent({ type: "agent_end", willRetry: true });
  projection.projectStepEvent({ type: "auto_retry_start", attempt: 1 });
  projection.projectStepEvent({ type: "agent_start" });
  assert.equal(ctx.currentTurnId, id);
  projection.projectStepEvent({ type: "message_start", message: { role: "assistant" } });
  projection.projectStepEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: finalReason } });
  projection.projectStepEvent({ type: "agent_settled" });
  const expected = finalReason === "stop" ? "completedSuccess" : finalReason === "aborted" ? "completedInterrupted" : "failed";
  assert.equal(ctx.conversationRows.filter(row => row.kind === "turnHeader").length, 1);
  assert.equal(ctx.conversationRows.filter(row => row.kind === "userInput").length, 1);
  assert.equal(ctx.conversationRows.find(row => row.kind === "turnHeader").state, expected);
  assert.ok(ctx.conversationRows.find(row => row.kind === "turnHeader").endedAt);
  assert.equal(frames.filter(frame => frame.payload.type === "turn.started").length, 1);
  assert.equal(frames.find(frame => frame.payload.type === "turn.completed").payload.turnId, id);
});
