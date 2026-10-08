import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { AttachmentStore } from "../src/attachments.mjs";
export const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
test("image chunks, retries, checksum, persisted send and authorized preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-images-"));
  let store = new AttachmentStore(root);
  const bytes = Buffer.from(PNG, "base64"),
    p = {
      sessionId: "a",
      connectionId: "c",
      uploadId: "upload-1",
      fileName: "粘贴.png",
      mime: "image/png",
      totalBytes: bytes.length,
      totalChunks: 2,
      checksum: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    };
  try {
    assert.equal((await store.begin(p)).state, "staging");
    store.chunk({ ...p, chunkIndex: 0, dataBase64: bytes.subarray(0, 20).toString("base64") });
    assert.equal(
      store.chunk({ ...p, chunkIndex: 0, dataBase64: bytes.subarray(0, 20).toString("base64") })
        .nextChunkIndex,
      1,
    );
    await assert.rejects(store.commit(p), /完整/);
    assert.throws(
      () => store.chunk({ ...p, connectionId: "other", chunkIndex: 1, dataBase64: "AAAA" }),
      /失效/,
    );
    store.chunk({ ...p, chunkIndex: 1, dataBase64: bytes.subarray(20).toString("base64") });
    const [first, repeat] = await Promise.all([store.commit(p), store.commit(p)]);
    assert.deepEqual(first, repeat);
    const { ref } = first;
    assert.equal((await store.begin(p)).state, "committed");
    store = new AttachmentStore(root);
    const a = { ref, fileName: p.fileName, mime: p.mime, bytes: bytes.length };
    assert.deepEqual(await store.images("a", [a]), [
      { type: "image", data: PNG, mimeType: "image/png" },
    ]);
    await assert.rejects(store.images("b", [a]), /当前会话/);
    await assert.rejects(store.read({ sessionId: "a", ref, offset: 0, limit: 512 }, []), /不属于/);
    const r = await store.read({ sessionId: "a", ref, offset: 0, limit: 512 }, [
      { kind: "userInput", rowId: 2, attachments: [a] },
    ]);
    assert.equal(r.dataBase64, PNG);
    assert.equal(r.nextOffset, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("invalid upload sizes and damaged checksums cannot commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-images-invalid-"));
  const store = new AttachmentStore(root),
    bytes = Buffer.from(PNG, "base64");
  const p = {
    sessionId: "a",
    connectionId: "c",
    uploadId: "bad",
    fileName: "a.png",
    mime: "image/png",
    totalBytes: bytes.length,
    totalChunks: 1,
    checksum: "sha256:" + "0".repeat(64),
  };
  try {
    await assert.rejects(store.begin({ ...p, totalBytes: 21 * 1024 * 1024 }), /20MB/);
    await store.begin(p);
    store.chunk({ ...p, chunkIndex: 0, dataBase64: PNG });
    await assert.rejects(store.commit(p), /校验失败/);
    store.abort(p);
    assert.throws(() => store.chunk({ ...p, chunkIndex: 0, dataBase64: PNG }), /失效/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
