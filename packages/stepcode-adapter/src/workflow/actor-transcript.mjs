import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { StepStreamProjection } from "../stream-projection.mjs";
import { SessionStatistics } from "../session-statistics.mjs";
import { makeTurnHeaderRow, makeUserInputRow } from "../wire-shapes.mjs";

const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

/** Step actor 客户端拥有内容；这里只把真实事件投影到既有只读 conversation 格式。 */
export class WorkflowActorTranscript {
  static async open(options) {
    const transcript = new WorkflowActorTranscript(options);
    try {
      const saved = JSON.parse(await readFile(transcript.file, "utf8"));
      transcript.rows = saved.rows;
      transcript.header = saved.rows.filter((row) => row.kind === "turnHeader").at(-1);
      transcript.stats = new SessionStatistics(saved.statistics);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (options.nativeSessionFile) await transcript.recoverNative(options.nativeSessionFile);
    }
    return transcript;
  }
  constructor(options) {
    this.options = options;
    this.file = join(options.conversationRoot, `${encodeURIComponent(options.sessionId)}.json`);
    this.rows = [];
    this.stats = new SessionStatistics();
    this.writeTail = Promise.resolve();
    this.turn = 0;
    this.session = {
      sessionId: options.sessionId,
      workspace: { workspacePath: options.cwd },
      modelSelection: options.model,
      createdAt: Date.now(),
      stepSessionFile: options.nativeSessionFile,
      title: options.name,
      titleSource: "custom",
      readOnly: true,
      workflowParentSessionId: options.parentSessionId,
      workflowRunId: options.runId,
    };
  }
  beginAsk(instructions) {
    this.turn++;
    const turnId = `${this.options.sessionId}-turn-${this.rows.length}-${this.turn}`;
    this.header = makeTurnHeaderRow({
      rowId: (this.rows.at(-1)?.rowId ?? 0) + 1,
      turnId,
      state: "running",
    });
    this.rows.push(
      this.header,
      makeUserInputRow({ rowId: this.header.rowId + 1, turnId, text: instructions }),
    );
    this.projection = new StepStreamProjection(this.rows, turnId, this.options.model?.modelId);
  }
  handle(event) {
    this.stats.handle(event);
    if (this.projection) this.projection.handle(event);
    if (event.type === "agent_settled" && this.header)
      this.header.state = this.projection?.outcome ?? "completedSuccess";
    this.schedule();
  }
  finish(state) {
    if (this.header?.state === "running") this.header.state = state;
    return this.flush();
  }
  schedule() {
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => {}); // flush 的同一写入链在 ask 结算时检查，失败不会被报成成功。
      }, 30);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const body = JSON.stringify({
      session: this.session,
      rows: this.rows,
      queueEntries: [],
      statistics: this.stats.serialize(),
    });
    this.writeTail = this.writeTail.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.actor.tmp`;
      await writeFile(temp, body, "utf8");
      await rename(temp, this.file);
      this.options.onChanged?.(this.options.sessionId);
    });
    return this.writeTail;
  }
  async recoverNative(file) {
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const entries = [];
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      try {
        entries.push(JSON.parse(lines[index]));
      } catch (error) {
        if (index < lines.length - 1) throw error;
      }
    }
    // 历史补投影只读原生账本，不发 prompt、不创建 Step 进程。
    for (const entry of entries) {
      const message = entry.type === "message" ? entry.message : undefined;
      if (!message) continue;
      if (message.role === "user") {
        if (this.header) this.header.state = this.projection?.outcome ?? "completedSuccess";
        this.beginAsk(textOf(message.content));
      } else if (message.role === "assistant" && this.projection) {
        this.projection.handle({ type: "message_start", message });
        this.projection.handle({ type: "message_end", message });
      } else if (message.role === "toolResult" && this.projection) {
        this.projection.handle({
          type: "tool_execution_end",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          result: { content: message.content },
        });
      }
    }
    if (this.header) this.header.state = this.projection?.outcome ?? "completedSuccess";
    this.stats.seed(entries);
  }
}

export async function hydrateActorTranscripts(options, journal, active) {
  if (!options.conversationRoot) return;
  for (const run of journal.listRunsByParentSession(options.sessionId, 64)) {
    if (active?.has(run.runId) || ["running", "pending"].includes(run.status)) continue;
    for (const actor of journal.listActors(run.runId)) {
      if (!actor.sessionId) continue;
      let pointer;
      try {
        pointer = JSON.parse(
          await readFile(
            join(options.root, "actors", `${encodeURIComponent(actor.sessionId)}.json`),
            "utf8",
          ),
        );
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const transcript = await WorkflowActorTranscript.open({
        conversationRoot: options.conversationRoot,
        sessionId: actor.sessionId,
        nativeSessionFile: pointer.sessionFile,
        cwd: options.cwd,
        model: pointer.model ?? options.model,
        name: actor.name,
        parentSessionId: options.sessionId,
        runId: run.runId,
        onChanged: options.onActorChanged,
      });
      await transcript.finish(
        run.status === "completed"
          ? "completedSuccess"
          : run.status === "stopped"
            ? "completedInterrupted"
            : "failed",
      );
    }
  }
}
