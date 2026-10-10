import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { syncForkActions, forkAssistant } from "../src/bridge/assistant-fork.mjs";
import { activeEntries } from "../src/bridge/history-controls.mjs";
import { AttachmentStore } from "../src/attachments.mjs";
import { httpFixture, projectedClient } from "./provider-wire-fixtures.mjs";
import { prepareProviderRequestOptions } from "../src/provider-request-options.mjs";

const rowsFor = (i, text) => [{ kind: "turnHeader", rowId: i * 3, turnId: String(i), state: "completedSuccess" }, { kind: "userInput", rowId: i * 3 + 1, turnId: String(i), origin: "realUser", text }, { kind: "assistantText", rowId: i * 3 + 2, turnId: String(i), text: "same reply" }];
test("分叉锚点按原生顺序绑定重复文本，只有完成轮最后正文可分叉", async () => {
  const branch = [1, 2, 3].flatMap(i => [{ id: `u${i}`, type: "message", message: { role: "user", content: [{ type: "text", text: "same" }] } }, { id: `a${i}`, type: "message", message: { role: "assistant", content: [{ type: "text", text: "same reply" }] } }]);
  const ctx = { primarySession: { sessionId: "s" }, conversationRows: [1, 2, 3].flatMap(i => rowsFor(i, "same")) };
  await syncForkActions(ctx, branch);
  for (const i of [1, 2, 3]) { assert.equal(ctx.primarySession.forkTargets[i * 3 + 2].assistantEntryId, `a${i}`); assert.equal(ctx.conversationRows[(i - 1) * 3 + 1].entityId, `u${i}`); }
  ctx.conversationRows[6].state = "running";
  await syncForkActions(ctx, branch);
  assert.equal(ctx.conversationRows[8].actions.canFork, undefined);
  assert.equal(ctx.primarySession.forkTargets[5].assistantEntryId, "a1");
});

test("真实底座可分叉旧回复及最新回复，保留父会话并独立续聊", { skip: !process.env.STEP_TEST_CLI, timeout: 60000 }, async () => {
  const http = await httpFixture("openai-chat-completions"), f = await projectedClient("openai-chat-completions", http.baseUrl);
  f.client.options.command = f.client.options.command.filter(x => x !== "--no-session");
  f.client.options.communicationMode = "required";
  try {
    await f.client.start(); await f.client.setModel(f.providerId, f.modelId);
    const prompt = async text => { await prepareProviderRequestOptions(f.client, { providerId: f.providerId, modelId: f.modelId, options: { reasoningLevel: "low" } }); return f.client.promptAndWait(text, { timeoutMs: 20000 }); };
    const store = new AttachmentStore(join(f.root, "attachments")), bytes = Buffer.from("fork document");
    const upload = { sessionId: "parent", connectionId: "c", uploadId: "u", fileName: "说明.txt", mime: "text/plain", totalBytes: bytes.length, totalChunks: 1, checksum: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
    await store.begin(upload); store.chunk({ ...upload, chunkIndex: 0, dataBase64: bytes.toString("base64") });
    const committed = await store.commit(upload), attachment = { ref: committed.ref, fileName: upload.fileName, mime: upload.mime };
    http.set({ kind: "text", text: "same reply" }); await prompt((await store.prepare("parent", [attachment], "one")).text); await prompt("two");
    const parentFile = (await f.client.getState()).sessionFile, parentBytes = await readFile(parentFile, "utf8");
    const branch = activeEntries((await f.client.request({ type: "get_entries" })).data);
    const ctx = { primarySession: { sessionId: "parent", stepSessionFile: parentFile, workspace: { workspacePath: f.root }, modelSelection: { providerId: f.providerId, modelId: f.modelId } }, conversationRows: [...rowsFor(1, "one"), ...rowsFor(2, "two")], attachmentStore: new AttachmentStore(join(f.root, "attachments")), conversationFile: id => join(f.root, "conversations", id + ".json"), runWithPreparedClient: async (_o, fn) => fn(f.client), persistSessionSummary() {}, pushPersistedUpserts() {} };
    ctx.conversationRows[1].attachments = [attachment];
    await syncForkActions(ctx, branch);
    for (const turn of [1, 2]) {
      const result = await forkAssistant(ctx, ctx.conversationRows[turn * 3 - 1], {}, branch);
      const child = JSON.parse(await readFile(ctx.conversationFile(result.sessionId), "utf8"));
      assert.equal(child.rows.length, turn * 3); assert.deepEqual(child.queueEntries, []);
      const preview = await store.read({ sessionId: result.sessionId, ref: attachment.ref, offset: 0, limit: 100 }, child.rows);
      assert.equal(Buffer.from(preview.dataBase64, "base64").toString(), "fork document");
      assert.equal((await f.client.getState()).sessionFile, parentFile); assert.equal(await readFile(parentFile, "utf8"), parentBytes);
      await f.client.request({ type: "switch_session", sessionPath: child.session.stepSessionFile });
      const messages = activeEntries((await f.client.request({ type: "get_entries" })).data).filter(e => e.type === "message");
      assert.equal(messages.filter(e => e.message.role === "user").length, turn);
      const firstText = messages.find(e => e.message.role === "user").message.content.find(p => p.type === "text").text;
      assert.ok(firstText.includes(JSON.stringify(store.directory(result.sessionId)).slice(1, -1)), "子会话文档路径已重映射");
      http.set({ kind: "text", text: "child reply" }); await prompt("child-only");
      assert.equal(await readFile(parentFile, "utf8"), parentBytes);
      await f.client.request({ type: "switch_session", sessionPath: parentFile });
    }
    http.set({ kind: "text", text: "parent continues" }); await prompt("parent-only");
    assert.ok((await readFile(parentFile, "utf8")).includes("parent-only"));
  } finally { await f.client.stop(); await http.close(); }
});

test("原生取消或索引写入失败不发布假成功，父会话始终恢复", async () => {
  const base = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-history-tests"; await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, "fork-"));
  const row = { ...rowsFor(1, "one")[2], entityId: "a", actions: { canFork: true } };
  let cancelled = true, restores = 0;
  const ctx = { primarySession: { sessionId: "parent", stepSessionFile: "parent.jsonl", workspace: { workspacePath: root }, forkTargets: { [row.rowId]: { entityId: "a", assistantEntryId: "a" } } }, conversationRows: [row], attachmentStore: new AttachmentStore(root + "/attachments"), conversationFile: id => root + "/" + id + ".json", runWithPreparedClient: async (_o, fn) => fn({ request: async p => { if (p.type === "switch_session") { restores++; return { success: true, data: { cancelled: false } }; } return { success: true, data: { cancelled } }; }, getState: async () => ({ sessionFile: "child.jsonl" }) }), persistSessionSummary: () => { throw new Error("index failed"); }, pushPersistedUpserts() {} };
  const branch = [{ id: "a", message: { role: "assistant" } }];
  await assert.rejects(forkAssistant(ctx, row, {}, branch), /取消/); assert.equal(restores, 1);
  cancelled = false; await assert.rejects(forkAssistant(ctx, row, {}, branch), /index failed/); assert.equal(restores, 2); assert.equal(ctx.primarySession.sessionId, "parent");
});
