import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeChatComposerAttachment } from "../packages/ui/src/lib/chatAttachments.js";
import { uploadComposerAttachment } from "../packages/ui/src/v4/composer/attachmentUpload.js";

// Node 下复现浏览器 FileReader，测试真实序列化与上传边界，不依赖桌面选择器。
Object.defineProperty(globalThis, "FileReader", { configurable: true, value: class {
  result = "";
  onload?: () => void;
  readAsDataURL(file: File) {
    void file.arrayBuffer().then(bytes => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    });
  }
}});

for (const [filename, mime, bytes] of [
  ["项目说明.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from([80, 75, 3, 4, 0, 255, 128])],
  ["长表格.csv", "text/csv", Buffer.from("项目,费用\n".repeat(15000))],
  ["空文件.txt", "text/plain", Buffer.alloc(0)],
] as const) {
  test(`composer preserves exact uploaded bytes: ${filename}`, async () => {
    const file = new File([bytes], filename, { type: mime });
    const serialized = await serializeChatComposerAttachment({ id: "fixture", file, filename, mimeType: mime, sizeBytes: bytes.length });
    let uploads = 0;
    const ref = await uploadComposerAttachment(async input => {
      uploads++;
      assert.equal(input.fileName, filename);
      assert.deepEqual(Buffer.from(input.dataBase64, "base64"), bytes);
      return { ref: "step-attachment:" + "a".repeat(64) };
    }, "test", serialized);
    assert.equal(uploads, 1);
    assert.equal(ref?.bytes, bytes.length);
  });
}

test("composer keeps explicit desktop path and rejects oversized inline files before encoding", async () => {
  const base = { id: "fixture", filename: "document.docx", mimeType: "application/octet-stream", sizeBytes: 21 * 1024 * 1024 };
  await assert.rejects(serializeChatComposerAttachment(base), /payloadTooLarge/);
  const serialized = await serializeChatComposerAttachment({ ...base, localPath: "D:/chosen/document.docx" });
  const ref = await uploadComposerAttachment(async () => { throw Error("desktop paths must not upload"); }, "test", serialized);
  assert.equal(ref?.ref, "D:/chosen/document.docx");
});
