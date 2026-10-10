import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AttachmentStore } from "../src/attachments.mjs";

for (const committed of [false, true]) {
  test(`${committed ? "提交附件" : "本机文件"} 八块重建只读取必要字节，保持内容、末块与最新文件`, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "attachment-range-"));
    const store = new AttachmentStore(root),
      size = 4 * 1024 * 1024,
      chunk = 512 * 1024;
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    let file = join(root, "data.bin"),
      ref = file;
    const originalReadFile = fs.readFile,
      originalOpen = fs.open;
    let bytesRead = 0,
      opens = 0,
      closes = 0;
    try {
      if (committed) {
        const p = {
          sessionId: "a",
          connectionId: "c",
          uploadId: "u",
          mime: "application/octet-stream",
          fileName: "data.bin",
          totalBytes: size,
          totalChunks: 8,
          checksum: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
        };
        await store.begin(p);
        for (let i = 0; i < 8; i++)
          store.chunk({
            ...p,
            chunkIndex: i,
            dataBase64: bytes.subarray(i * chunk, (i + 1) * chunk).toString("base64"),
          });
        ({ ref } = await store.commit(p));
        file = join(store.directory("a"), ref.slice(16) + ".bin");
      } else await fs.writeFile(file, bytes);
      fs.readFile = async (path, ...args) => {
        const value = await originalReadFile(path, ...args);
        if (String(path) === file) bytesRead += Buffer.byteLength(value);
        return value;
      };
      fs.open = async (...args) => {
        const h = await originalOpen(...args);
        if (String(args[0]) === file) {
          opens++;
          const read = h.read.bind(h),
            close = h.close.bind(h);
          h.read = async (...a) => {
            const r = await read(...a);
            bytesRead += r.bytesRead;
            return r;
          };
          h.close = async () => {
            closes++;
            return close();
          };
        }
        return h;
      };
      syncBuiltinESMExports();
      const rows = [
        {
          kind: "userInput",
          rowId: 1,
          attachments: [{ ref, mime: "application/octet-stream", fileName: "data.bin" }],
        },
      ];
      const params = {
        sessionId: "a",
        ref,
        target: { rowId: 1 },
        attachmentIndex: 0,
        limit: chunk,
      };
      const pieces = [];
      for (let offset = 0; offset < size; offset += chunk) {
        const r = await store.read({ ...params, offset }, rows);
        pieces.push(Buffer.from(r.dataBase64, "base64"));
        assert.equal(r.totalBytes, size);
        assert.equal(r.nextOffset, offset + chunk < size ? offset + chunk : null);
      }
      assert.deepEqual(Buffer.concat(pieces), bytes);
      assert.equal(bytesRead, size);
      assert.equal(opens, 8);
      assert.equal(closes, opens);
      const empty = await store.read({ ...params, offset: size + 5 }, rows);
      assert.equal(empty.dataBase64, "");
      assert.equal(empty.nextOffset, null);
      bytes[123] = 255;
      await fs.writeFile(file, bytes);
      const fresh = await store.read({ ...params, offset: 120, limit: 5 }, rows);
      assert.deepEqual(Buffer.from(fresh.dataBase64, "base64"), bytes.subarray(120, 125));
      const tail = await store.read({ ...params, offset: size - 3 }, rows);
      assert.equal(Buffer.from(tail.dataBase64, "base64").length, 3);
      assert.equal(tail.nextOffset, null);
      await assert.rejects(
        store.read({ ...params, offset: 0, target: { rowId: 2 } }, rows),
        /不属于/,
      );
      await assert.rejects(
        store.read({ ...params, offset: 0, attachmentIndex: 1 }, rows),
        /不属于/,
      );
      assert.equal(opens, closes);
    } finally {
      fs.readFile = originalReadFile;
      fs.open = originalOpen;
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("范围读取保留图片签名、大小与文件类型检查，并关闭失败句柄", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "attachment-errors-")),
    store = new AttachmentStore(root),
    file = join(root, "image.png");
  const original = fs.open;
  let opens = 0,
    closes = 0;
  fs.open = async (...args) => {
    const h = await original(...args);
    opens++;
    const close = h.close.bind(h);
    h.close = async () => {
      closes++;
      return close();
    };
    return h;
  };
  syncBuiltinESMExports();
  const run = (ref = file, extra = {}) =>
    store.read({ sessionId: "a", ref, offset: 0, limit: 5, ...extra }, [
      { kind: "userInput", attachments: [{ ref, mime: "image/png" }] },
    ]);
  try {
    await fs.writeFile(file, Buffer.alloc(30));
    await assert.rejects(run(), /格式不符/);
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(30)]);
    await fs.writeFile(file, png);
    const result = await run(file, { offset: 9 });
    assert.equal(result.dataBase64, Buffer.alloc(5).toString("base64"));
    await assert.rejects(run(root), /普通文件/);
    await fs.writeFile(file, Buffer.alloc(20 * 1024 * 1024 + 1));
    await assert.rejects(run(), /20MB/);
    await fs.rm(file);
    await assert.rejects(run(), { code: "ENOENT" });
    assert.equal(opens, closes);
  } finally {
    fs.open = original;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("短读继续填满、提前 EOF 和读取异常均关闭句柄", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "attachment-short-read-")),
    file = join(root, "bytes.bin"),
    store = new AttachmentStore(root);
  const original = fs.open;
  let mode = "partial",
    closed = 0;
  await fs.writeFile(file, Buffer.from("abcdefgh"));
  fs.open = async (...args) => {
    const h = await original(...args),
      read = h.read.bind(h),
      close = h.close.bind(h);
    let calls = 0;
    h.read = async (buffer, offset, length, position) => {
      calls++;
      if (mode === "error") throw new Error("read failed");
      if (mode === "eof" && calls > 1) return { bytesRead: 0, buffer };
      return read(buffer, offset, Math.min(2, length), position);
    };
    h.close = async () => {
      closed++;
      return close();
    };
    return h;
  };
  syncBuiltinESMExports();
  const run = () =>
    store.read({ sessionId: "a", ref: file, offset: 1, limit: 6 }, [
      { kind: "userInput", attachments: [{ ref: file, mime: "application/octet-stream" }] },
    ]);
  try {
    assert.equal(Buffer.from((await run()).dataBase64, "base64").toString(), "bcdefg");
    assert.equal(closed, 1);
    mode = "eof";
    await assert.rejects(run(), /发生变化/);
    assert.equal(closed, 2);
    mode = "error";
    await assert.rejects(run(), /read failed/);
    assert.equal(closed, 3);
  } finally {
    fs.open = original;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
