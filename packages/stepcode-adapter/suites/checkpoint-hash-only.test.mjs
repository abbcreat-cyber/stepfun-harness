import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readImage, checkpointPreview, applyCheckpoints } from "../src/file-checkpoints.mjs";

test("撤销预览只比较哈希，不生成 Base64；应用与undo仍保留完整内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-hash-")),
    path = join(root, "data.txt"),
    beforeBytes = Buffer.alloc(1024 * 1024, 65),
    afterBytes = Buffer.alloc(1024 * 1024, 66);
  const original = Buffer.prototype.toString;
  let encoded = 0;
  try {
    await writeFile(path, beforeBytes);
    const before = await readImage(path);
    await writeFile(path, afterBytes);
    const after = await readImage(path);
    const files = [
      { path, calls: [{ toolName: "write_file", before, after: after.hash, afterImage: after }] },
    ];
    Buffer.prototype.toString = function (encoding, ...args) {
      if (encoding === "base64") encoded += this.length;
      return original.call(this, encoding, ...args);
    };
    const preview = await checkpointPreview(files);
    assert.equal(preview.canApply, true);
    assert.equal(encoded, 0);
    Buffer.prototype.toString = original;
    const applied = await applyCheckpoints(files);
    assert.equal(applied.applied, true);
    assert.deepEqual(await readFile(path), beforeBytes);
    await applied.undo();
    assert.deepEqual(await readFile(path), afterBytes);
    await writeFile(path, "external");
    assert.equal((await checkpointPreview(files)).unsafeFiles[0].reason, "external_modified");
    assert.equal((await applyCheckpoints(files)).applied, false);
  } finally {
    Buffer.prototype.toString = original;
    await rm(root, { recursive: true, force: true });
  }
});
