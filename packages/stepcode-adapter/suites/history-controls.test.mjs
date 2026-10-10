import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerFileCheckpoints, checkpointsFor, checkpointPreview, applyCheckpoints } from "../src/file-checkpoints.mjs";
import { activeEntries, createHistoryControls } from "../src/bridge/history-controls.mjs";

test("文件操作前后快照、外部冲突、新文件与中文空格路径", async () => {
  const base = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-history-tests";
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, "history-"));
  const handlers = {}, entries = [];
  registerFileCheckpoints({ on: (k, fn) => { handlers[k] = fn; }, appendEntry: (customType, data) => entries.push({ customType, data: structuredClone(data) }) });
  const ctx = { cwd: root, sessionManager: { getBranch: () => [{ type: "message", id: "u", message: { role: "user" } }] } };
  const path = join(root, "中文 文件.txt"); await writeFile(path, "before");
  const event = { toolName: "write_file", toolCallId: "t", input: { path } };
  await handlers.tool_call(event, ctx); await writeFile(path, "after"); await handlers.tool_result(event);
  const files = checkpointsFor(entries, "u");
  assert.equal((await checkpointPreview(files)).canApply, true);
  await writeFile(path, "external"); assert.equal((await applyCheckpoints(files)).applied, false);
  assert.equal(await readFile(path, "utf8"), "external");
  await writeFile(path, "after"); const restored = await applyCheckpoints(files);
  assert.equal(await readFile(path, "utf8"), "before"); await restored.undo(); assert.equal(await readFile(path, "utf8"), "after");
  event.toolCallId = "new"; event.input.path = join(root, "new.txt");
  await handlers.tool_call(event, ctx); await writeFile(event.input.path, "created"); await handlers.tool_result(event);
  assert.equal((await applyCheckpoints(checkpointsFor(entries, "u"))).applied, true);
  await assert.rejects(readFile(event.input.path), { code: "ENOENT" });
});

test("原生树仅保留当前分支，缺链拒绝", () => {
  const entries = [{ id: "1", parentId: null }, { id: "old", parentId: "1" }, { id: "new", parentId: "1" }];
  assert.deepEqual(activeEntries({ entries, leafId: "new" }).map(e => e.id), ["1", "new"]);
  assert.throws(() => activeEntries({ entries, leafId: "missing" }));
});

test("编辑 fork 取消不能修改历史，成功使用新路径并保留附件，旧 target 拒绝", async () => {
  const user = { kind: "userInput", rowId: 2, turnId: "t", entityId: "u", origin: "realUser", text: "old", attachments: [{ id: "a" }] };
  let cancelled = true, sent;
  const ctx = { stateRevision: 5, logEpoch: "epoch", turnBusy: false, primarySession: { sessionId: "s", stepSessionFile: "old.jsonl" },
    conversationRows: [{ kind: "turnHeader", rowId: 1, turnId: "t" }, user], ledger: { managedQueued: () => [] },
    workflowBridge: { snapshot: () => ({ backgroundWorks: [] }) }, attachmentStore: { prepare: async (_s, _a, text) => ({ text }) },
    restoreSession: async () => {}, persistConversation() {}, broadcastConversationSnapshot() {},
    admitAndSend: async input => { sent = input; } };
  const client = { request: async p => p.type === "get_entries" ? { success: true, data: { entries: [{ id: "u", parentId: null, type: "message", message: { role: "user" } }], leafId: "u" } } : { success: true, data: { cancelled } }, getState: async () => ({ sessionFile: "new.jsonl" }) };
  ctx.runWithPreparedClient = async (_options, fn) => fn(client);
  const api = createHistoryControls(ctx);
  const envelope = { type: "editUserQuery", commandId: "edit", sessionId: "s", baseRevision: 5, baseLogEpoch: "epoch", payload: { target: { rowId: 2, entityId: "u" }, newText: "new" } };
  await assert.rejects(api.historyCommand({ ...envelope, baseLogEpoch: "old" }, 5), /已变化/);
  ctx.turnBusy = true; await assert.rejects(api.historyCommand(envelope, 5), /停止当前任务/); ctx.turnBusy = false;
  ctx.ledger.managedQueued = () => [{ id: "queued" }]; await assert.rejects(api.historyCommand(envelope, 5), /排队消息/); ctx.ledger.managedQueued = () => [];
  await assert.rejects(api.historyCommand(envelope, 5), /取消/); assert.equal(ctx.conversationRows.length, 2);
  cancelled = false; await api.historyCommand(envelope, 5);
  assert.equal(ctx.primarySession.stepSessionFile, "new.jsonl"); assert.deepEqual(sent.attachments, user.attachments); assert.equal(sent.text, "new");
  assert.equal(ctx.primarySession.rowHighWater, 2); assert.equal(ctx.conversationRows.length, 0);
  await assert.rejects(api.historyCommand(envelope, 5), /失效/);
});

test("并发同路径与未结束的工具检查点拒绝回退", async () => {
  const base = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-history-tests";
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, "overlap-"));
  const handlers = {}, entries = [], path = join(root, "overlap.txt");
  await writeFile(path, "original");
  registerFileCheckpoints({ on: (k, fn) => { handlers[k] = fn; }, appendEntry: (customType, data) => entries.push({ customType, data: structuredClone(data) }) });
  const ctx = { cwd: root, sessionManager: { getBranch: () => [{ type: "message", id: "u", message: { role: "user" } }] } };
  const a = { toolName: "write_file", toolCallId: "a", input: { path } }, b = { ...a, toolCallId: "b" };
  await handlers.tool_call(a, ctx);
  assert.equal((await checkpointPreview(checkpointsFor(entries, "u"))).unsafeFiles[0].reason, "checkpoint_missing");
  await handlers.tool_call(b, ctx); await writeFile(path, "changed"); await handlers.tool_result(a); await handlers.tool_result(b);
  assert.equal((await checkpointPreview(checkpointsFor(entries, "u"))).unsafeFiles[0].reason, "unsupported_checkpoint");
  assert.equal((await applyCheckpoints(checkpointsFor(entries, "u"))).applied, false);
  assert.equal(await readFile(path, "utf8"), "changed");
});
