import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkpointDiff } from "../src/checkpoint-diff.mjs";
import { applyCheckpoints, checkpointPreview, CHECKPOINT, hashBytes } from "../src/file-checkpoints.mjs";
import { createHistoryControls } from "../src/bridge/history-controls.mjs";

const data = text => Buffer.from(text).toString("base64");
const image = text => ({ data: data(text), hash: hashBytes(Buffer.from(text)) });
const diff = (a, b, options) => checkpointDiff(data(a), data(b), options);

test("远隔编辑只统计改变的行，分段保持真实行号", () => {
  const before = Array.from({ length: 1000 }, (_, i) => `line-${i}\n`);
  const after = [...before]; after[3] = "changed-first\n"; after[993] = "changed-last\n";
  const result = diff(before.join(""), after.join(""));
  assert.equal(result.additions, 2); assert.equal(result.deletions, 2);
  assert.deepEqual(result.patches.map(p => p.oldStart), [4, 994]);
  assert.deepEqual(result.patches[0].lines, ["-line-3", "+changed-first"]);
});

test("新增删除与末尾换行变化可见；有界退化仍保留完整修改", () => {
  assert.deepEqual(diff("", "a\n").patches[0], { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+a"] });
  assert.equal(diff("a\n", "").patches[0].newStart, 0);
  assert.deepEqual(diff("a", "a\n").patches[0].lines, ["-a", "\\ No newline at end of file", "+a"]);
  assert.equal(diff("a\r\n", "a\n").deletions, 1);
  const result = diff("a\nb\nc\n", "x\nb\ny\n", { budget: 0 });
  assert.equal(result.additions, 3); assert.equal(result.deletions, 3);
});

test("重复行和随机插删的补丁可重建目标且计数与行一致", () => {
  let seed = 51;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const before = Array.from({ length: random(50) }, () => `${random(8)}`);
    const after = [...before];
    for (let i = 0; i < 8; i++) after.splice(random(after.length + 1), random(3), ...Array.from({ length: random(3) }, () => `${random(8)}`));
    const result = diff(before.map(l => l + "\n").join(""), after.map(l => l + "\n").join(""));
    const reconstructed = [...before];
    for (const p of [...result.patches].reverse()) {
      const offset = p.oldLines ? p.oldStart - 1 : p.oldStart;
      assert.deepEqual(before.slice(offset, offset + p.oldLines), p.lines.filter(l => l[0] === "-").map(l => l.slice(1)));
      reconstructed.splice(offset, p.oldLines, ...p.lines.filter(l => l[0] === "+").map(l => l.slice(1)));
    }
    assert.deepEqual(reconstructed, after);
    assert.equal(result.additions, result.patches.flatMap(p => p.lines).filter(l => l[0] === "+").length);
  }
});

test("无变化文件随后外部修改不会阻塞其他文件撤销，也不会被覆盖", async () => {
  const base = "D:/Temp/stepcode-history-tests"; await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "noop-"));
  const unchanged = join(root, "unchanged.txt"), changed = join(root, "changed.txt");
  await writeFile(unchanged, "external"); await writeFile(changed, "after");
  const record = (path, before, after) => ({ path, calls: [{ toolName: "edit_file", before: image(before), after: image(after).hash, afterImage: image(after) }] });
  const files = [record(unchanged, "original", "original"), record(changed, "before", "after")];
  assert.equal((await checkpointPreview(files)).canApply, true);
  const applied = await applyCheckpoints(files); assert.equal(applied.applied, true);
  assert.equal(await readFile(changed, "utf8"), "before"); assert.equal(await readFile(unchanged, "utf8"), "external");
  await applied.undo();
  await writeFile(changed, "external-real-conflict");
  assert.equal((await checkpointPreview(files)).unsafeFiles[0].reason, "external_modified");
  files[0].calls[0].overlap = true;
  assert.equal((await checkpointPreview(files)).unsafeFiles[0].reason, "unsupported_checkpoint");
  delete files[0].calls[0].after;
  assert.equal((await checkpointPreview(files)).unsafeFiles[0].reason, "checkpoint_missing");
});

test("未完成或净变化为零的历史同步清除活动摘要，保留已撤销记录", async () => {
  for (const mode of ["incomplete", "noop", "reverted"]) {
    const header = { kind: "turnHeader", rowId: 1, turnId: "turn", actions: { canRewindFiles: true }, fileChanges: { files: 1, additions: 1, deletions: 1, state: mode === "reverted" ? "reverted" : "active" } };
    const user = { kind: "userInput", origin: "realUser", rowId: 2, turnId: "turn", text: "edit" };
    const entries = [{ id: "u", parentId: null, type: "message", message: { role: "user", content: "edit" } }, { id: "c", parentId: "u", customType: CHECKPOINT, data: { userId: "u", toolCallId: "t", path: "file", before: image("same"), ...(mode === "incomplete" ? {} : { after: image("same").hash, afterImage: image("same") }) } }];
    const ctx = { primarySession: { sessionId: "s" }, conversationRows: [header, user], client: { isRunning: () => true, request: async () => ({ success: true, data: { entries, leafId: "c" } }) }, attachmentStore: { prepare: async () => ({ text: "edit" }) }, persistConversation() {}, broadcastConversationSnapshot() {} };
    await createHistoryControls(ctx).syncHistoryControls();
    if (mode === "reverted") assert.equal(header.fileChanges.state, "reverted");
    else { assert.equal(header.fileChanges, undefined); assert.equal(header.actions.canRewindFiles, undefined); }
  }
});
