import test from "node:test";
import assert from "node:assert/strict";
import { readPreviewBytes } from "../src/lib/readPreviewBytes.js";
test("PDF读取按剩余长度请求，短读完整拼接且不包含增长的文件尾", async () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    calls: number[][] = [];
  const result = await readPreviewBytes(
    7,
    3,
    async (offset, length) => {
      calls.push([offset, length]);
      return bytes.slice(offset, offset + Math.min(length, 2));
    },
    () => false,
  );
  assert.deepEqual(result, bytes.slice(0, 7));
  assert.deepEqual(calls, [
    [0, 3],
    [2, 3],
    [4, 3],
    [6, 1],
  ]);
});
test("PDF读取处理EOF、零长度、取消和错误", async () => {
  const ended = await readPreviewBytes(
    5,
    2,
    async (offset) => (offset === 0 ? new Uint8Array([9, 8]) : new Uint8Array()),
    () => false,
  );
  assert.deepEqual(ended, new Uint8Array([9, 8]));
  assert.equal(ended?.buffer.byteLength, 2);
  let calls = 0;
  assert.equal(
    await readPreviewBytes(
      5,
      2,
      async () => {
        calls++;
        return new Uint8Array([1]);
      },
      () => true,
    ),
    null,
  );
  assert.equal(calls, 0);
  let cancelled = false;
  assert.equal(
    await readPreviewBytes(
      5,
      2,
      async () => {
        cancelled = true;
        return new Uint8Array([1]);
      },
      () => cancelled,
    ),
    null,
  );
  assert.deepEqual(
    await readPreviewBytes(
      0,
      2,
      async () => {
        throw Error("should not read");
      },
      () => false,
    ),
    new Uint8Array(),
  );
  await assert.rejects(
    readPreviewBytes(
      5,
      2,
      async () => {
        throw Error("read failed");
      },
      () => false,
    ),
    /read failed/,
  );
});
