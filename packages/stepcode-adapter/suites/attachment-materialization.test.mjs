import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AttachmentStore } from "../src/attachments.mjs";
import { createHistoryControls } from "../src/bridge/history-controls.mjs";
import { syncForkActions } from "../src/bridge/assistant-fork.mjs";

async function fixture(t, { mime = "text/plain", fileName = "文档.txt", text = "original" } = {}) {
  const base = "D:/Temp/stepcode-attachment-tests"; await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "materialize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AttachmentStore(root), bytes = Buffer.from(text);
  const p = { sessionId: "s", connectionId: "c", uploadId: "u", mime, fileName, totalBytes: bytes.length, totalChunks: bytes.length ? 1 : 0, checksum: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
  await store.begin(p); if (bytes.length) store.chunk({ ...p, chunkIndex: 0, dataBase64: bytes.toString("base64") });
  const { ref } = await store.commit(p);
  return { store, root, attachment: { ref, mime, fileName, bytes: bytes.length } };
}

test("工具改过的附件在重复准备与重启后保留内容和修改时间", async t => {
  const { store, root, attachment } = await fixture(t);
  const first = await store.prepare("s", [attachment], "edit"); const path = first.files[0].path;
  await writeFile(path, "model edited"); const before = await stat(path);
  assert.equal((await store.prepare("s", [attachment], "edit")).text, first.text);
  assert.equal((await new AttachmentStore(root).prepare("s", [attachment], "edit")).text, first.text);
  assert.equal(await readFile(path, "utf8"), "model edited");
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
});

test("历史准备不写副本，不恢复被删除的附件，不读文档原始字节", async t => {
  const { store, attachment } = await fixture(t);
  const first = await store.prepare("s", [attachment], "edit");
  await rm(first.files[0].path);
  const source = await store.source("s", attachment); await rm(source.path);
  const history = await store.prepare("s", [attachment], "edit", { materialize: false, includeImages: false });
  assert.equal(history.text, first.text); await assert.rejects(stat(first.files[0].path), { code: "ENOENT" });
  await assert.rejects(store.prepare("s", [attachment], "edit"), { code: "ENOENT" });
});

test("图片历史同步不读取图片，真正发送仍拒绝丢失的原图", async t => {
  const { store, attachment } = await fixture(t);
  // 已提交元数据模拟历史图片；测试只修改隔离 fixture，不涉及真实图片或用户资料。
  const id = attachment.ref.slice(16), path = join(store.directory("s"), id + ".json");
  const meta = JSON.parse(await readFile(path, "utf8")); meta.mime = "image/png"; await writeFile(path, JSON.stringify(meta));
  await rm(join(store.directory("s"), id + ".bin"));
  const result = await store.prepare("s", [attachment], "question", { materialize: false, includeImages: false });
  assert.equal(result.text, "question"); assert.deepEqual(result.images, []);
  await assert.rejects(store.prepare("s", [attachment], "question"), { code: "ENOENT" });
});

test("并发准备返回完整副本，目录冲突可重试", async t => {
  const { store, attachment } = await fixture(t, { text: "中文".repeat(50000) });
  const results = await Promise.all(Array.from({ length: 8 }, () => store.prepare("s", [attachment])));
  const path = results[0].files[0].path; assert.ok(results.every(r => r.files[0].path === path));
  assert.equal(await readFile(path, "utf8"), "中文".repeat(50000));
  await rm(path); await mkdir(path);
  await assert.rejects(store.prepare("s", [attachment]), /普通文件/);
  await rm(path, { recursive: true });
  await store.prepare("s", [attachment]); assert.equal(await readFile(path, "utf8"), "中文".repeat(50000));
});

test("编辑重试和分叉按钮同步走只读路径，不复活已删除的文档", async t => {
  const { store, attachment } = await fixture(t);
  const prepared = await store.prepare("s", [attachment], "edit");
  await rm(prepared.files[0].path); await rm((await store.source("s", attachment)).path);
  const user = { kind: "userInput", rowId: 2, turnId: "turn", origin: "realUser", text: "edit", attachments: [attachment] };
  const branch = [{ type: "message", id: "native-user", parentId: null, message: { role: "user", content: prepared.text } }];
  const ctx = { primarySession: { sessionId: "s" }, conversationRows: [{ kind: "turnHeader", turnId: "turn", rowId: 1 }, user], attachmentStore: store,
    client: { isRunning: () => true, request: async () => ({ success: true, data: { entries: branch, leafId: "native-user" } }) }, persistConversation() {}, broadcastConversationSnapshot() {} };
  await createHistoryControls(ctx).syncHistoryControls(); assert.equal(user.actions.canEdit, true);
  delete user.entityId;
  await syncForkActions(ctx, branch); assert.equal(user.entityId, "native-user");
  await assert.rejects(stat(prepared.files[0].path), { code: "ENOENT" });
});
