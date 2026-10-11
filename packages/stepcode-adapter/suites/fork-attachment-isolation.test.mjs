import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AttachmentStore } from "../src/attachments.mjs";
import { forkAssistant } from "../src/bridge/assistant-fork.mjs";
import { attachmentPathRemapper } from "../src/bridge/fork-attachment-paths.mjs";

async function fixture(t) {
  const base = "D:/Temp/stepcode-history-tests"; await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, "fork-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AttachmentStore(join(root, "attachments")), bytes = Buffer.from("original");
  const p = { sessionId: "parent", connectionId: "c", uploadId: "u", fileName: "附件.txt", mime: "text/plain", totalBytes: bytes.length, totalChunks: 1, checksum: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
  await store.begin(p); store.chunk({ ...p, chunkIndex: 0, dataBase64: bytes.toString("base64") });
  const attachment = { ...await store.commit(p), fileName: p.fileName, mime: p.mime };
  const prepared = await store.prepare("parent", [attachment], "edit"), parentPath = prepared.files[0].path;
  await writeFile(parentPath, "edited by parent");
  const parentFile = join(root, "parent.jsonl"), nativeChild = join(root, "child.jsonl");
  const branch = [
    { id: "u", type: "message", message: { role: "user", content: [{ type: "text", text: prepared.text }] } },
    { id: "tool", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit_file", arguments: { path: parentPath.replaceAll("\\", "/"), search: "original", replace: "edited by parent" } }] } },
    { id: "result", type: "message", message: { role: "toolResult", content: [{ type: "text", text: `Updated ${parentPath}\nUnrelated: ${parentPath}.backup` }] } },
    { id: "checkpoint", customType: "desktop-file-checkpoint-v1", data: { path: parentPath } },
    { id: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  await writeFile(parentFile, branch.map(e => JSON.stringify(e)).join("\n") + "\n");
  const row = { kind: "assistantText", rowId: 4, turnId: "t", entityId: "a", text: "done", actions: { canFork: true } };
  const ctx = { primarySession: { sessionId: "parent", stepSessionFile: parentFile, workspace: { workspacePath: root }, forkTargets: { 4: { entityId: "a", assistantEntryId: "a" } } },
    conversationRows: [{ kind: "turnHeader", rowId: 1, turnId: "t" }, { kind: "userInput", origin: "realUser", rowId: 2, turnId: "t", text: "edit", attachments: [attachment] }, { kind: "toolCall", rowId: 3, turnId: "t", input: { path: parentPath }, inputText: JSON.stringify({ path: parentPath }), output: { text: parentPath } }, row],
    attachmentStore: store, conversationFile: id => join(root, id + ".json"), persistSessionSummary() {}, pushPersistedUpserts() {},
    runWithPreparedClient: async (_options, fn) => fn({ request: async p => { if (p.type !== "switch_session") await cp(parentFile, nativeChild); return { success: true }; }, getState: async () => ({ sessionFile: nativeChild }) }),
  };
  return { store, attachment, parentPath, parentFile, nativeChild, branch, row, ctx };
}

test("分叉保留已修改附件并同步迁移原生与前端工具路径，父会话独立", async t => {
  const f = await fixture(t), before = await readFile(f.parentFile, "utf8");
  const result = await forkAssistant(f.ctx, f.row, {}, f.branch);
  const child = JSON.parse(await readFile(f.ctx.conversationFile(result.sessionId), "utf8"));
  const prepared = await f.store.prepare(result.sessionId, [f.attachment], "", { materialize: false, includeImages: false });
  const childPath = prepared.files[0].path;
  assert.equal(await readFile(childPath, "utf8"), "edited by parent");
  const native = (await readFile(f.nativeChild, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(native[1].message.content[0].arguments.path, childPath.replaceAll("\\", "/"));
  assert.equal(native[2].message.content[0].text, `Updated ${childPath}\nUnrelated: ${f.parentPath}.backup`);
  assert.equal(native[3].data.path, childPath);
  assert.equal(child.rows[2].input.path, childPath);
  assert.equal(JSON.parse(child.rows[2].inputText).path, childPath);
  assert.equal(child.rows[2].output.text, childPath);
  await writeFile(childPath, "edited by child");
  assert.equal(await readFile(f.parentPath, "utf8"), "edited by parent");
  assert.equal(await readFile((await f.store.source(result.sessionId, f.attachment)).path, "utf8"), "original");
  assert.equal(await readFile(f.parentFile, "utf8"), before);
  assert.equal(f.ctx.conversationRows[2].input.path, f.parentPath);
});

test("分叉不复活已经删除的工作副本，保留原始附件用于预览", async t => {
  const f = await fixture(t); await rm(f.parentPath);
  const result = await forkAssistant(f.ctx, f.row, {}, f.branch);
  const prepared = await f.store.prepare(result.sessionId, [f.attachment], "", { materialize: false, includeImages: false });
  await assert.rejects(readFile(prepared.files[0].path), { code: "ENOENT" });
  assert.equal(await readFile((await f.store.source(result.sessionId, f.attachment)).path, "utf8"), "original");
});

test("路径映射兼容 JSON 嵌套文本及正文，不改同前缀其他文件或源对象", () => {
  const from = "D:/parent/[a]/file.txt", to = "D:/child/$&/file.txt";
  const input = { user: { content: `附件：\n${JSON.stringify([{ path: from }])}` },
    text: `Read (${from}), keep ${from}.backup and ${from}/other and prefix${from}`, exact: from };
  const before = structuredClone(input), mapped = attachmentPathRemapper([[from, to]])(input);
  assert.deepEqual(input, before);
  assert.equal(JSON.parse(mapped.user.content.split("\n")[1])[0].path, to);
  assert.equal(mapped.exact, to);
  assert.equal(mapped.text, `Read (${to}), keep ${from}.backup and ${from}/other and prefix${from}`);
});

test("Windows 反斜杠、正斜杠及大小写变体指向同一子副本", { skip: process.platform !== "win32" }, () => {
  const from = "D:\\Parent\\File.txt", to = "D:\\Child\\File.txt", remap = attachmentPathRemapper([[from, to]]);
  assert.equal(remap(from.toUpperCase()), to);
  assert.equal(remap("d:/parent/file.txt"), "D:/Child/File.txt");
  assert.deepEqual(JSON.parse(remap(JSON.stringify({ path: from }))), { path: to });
});
