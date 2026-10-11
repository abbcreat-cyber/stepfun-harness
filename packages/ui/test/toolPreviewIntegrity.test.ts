import test from "node:test";
import assert from "node:assert/strict";
import { getToolCallCodePreview, getToolCallCodeContentPreview } from "../src/lib/codeViewer.js";
import { getToolCallErrorText } from "../src/lib/toolError.js";
import { buildToolDisplayModel } from "../src/lib/toolDisplay.js";

const read = (output: unknown, path = "中文 文件.txt") => ({
  toolId: "r",
  kind: "read_file",
  status: "completed",
  input: { path },
  output,
});
test("空文件与空白文件保持原始内容", () => {
  for (const text of ["", " \n\t"]) {
    for (const output of [text, { text }]) {
      const p = getToolCallCodePreview(read(output), "D:/work");
      assert.equal(p?.type, "text");
      if (p?.type === "text") assert.equal(p.content, text);
      assert.equal(getToolCallCodeContentPreview(read(output), "D:/work")?.content, text);
    }
  }
  const p = getToolCallCodePreview(
    {
      toolId: "w",
      kind: "write_file",
      status: "completed",
      input: { path: "empty.txt", content: "" },
      output: "saved",
    },
    "D:/work",
  );
  assert.equal(p?.type, "text");
  if (p?.type === "text") assert.equal(p.content, "");
});
test("读取正文的 diff 标记和错误标签不改变工具语义", () => {
  for (const text of [
    "--- before\n+++ after\n@@ -1 +1 @@\n-old\n+new",
    "<tool_use_error>这是文档示例</tool_use_error>",
  ]) {
    assert.equal(getToolCallCodePreview(read(text), "D:/work")?.type, "text");
    assert.equal(getToolCallErrorText(read(text)), undefined);
    assert.equal(buildToolDisplayModel(read(text), "D:/work").inlinePreview.type, "text");
  }
  assert.equal(
    getToolCallErrorText({ status: "completed", output: { message: "读取完成" } }),
    undefined,
  );
  assert.equal(
    getToolCallErrorText({ status: "completed", raw: { rawOutput: { message: "保存成功" } } }),
    undefined,
  );
});
test("图片说明不遮住位图；SVG源代码仍可查看", () => {
  const p = getToolCallCodePreview(read("Image attached", "中文 #1.PNG"), "D:/work");
  assert.equal(p?.type, "image");
  assert.equal(p?.path, "D:/work/中文 #1.PNG");
  assert.equal(getToolCallCodeContentPreview(read("Image attached", "image.png"), "D:/work"), null);
  assert.equal(getToolCallCodePreview(read("<svg/>", "image.svg"), "D:/work")?.type, "text");
});
test("失败原因保留且不冒充文件内容，停止也不生成已完成预览", () => {
  for (const output of [
    "ENOENT: missing",
    { text: "ENOENT: missing" },
    { message: "ENOENT: missing" },
  ]) {
    const call = { ...read(output), status: "failed" };
    assert.equal(getToolCallErrorText(call), "ENOENT: missing");
    assert.equal(getToolCallCodePreview(call, "D:/work"), null);
    assert.equal(getToolCallCodeContentPreview(call, "D:/work"), null);
  }
  assert.equal(getToolCallCodePreview({ ...read("partial"), status: "stopped" }, "D:/work"), null);
  assert.equal(
    getToolCallErrorText({ status: "completed", error: "Explicit failure" }),
    "Explicit failure",
  );
});
