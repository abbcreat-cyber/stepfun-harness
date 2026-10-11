import assert from "node:assert/strict";
import test from "node:test";
import { extractBeforeAfter } from "../src/lib/toolDiffPreview.js";
import { buildFallbackRawToolCallFileSummary } from "../src/ToolCallBlocks/fileSummaryHeuristics.js";

test("原生 edit_file 在权限与聊天文件摘要中产生差异", () => {
  const input = {
    path: "D:/test/中文.txt",
    search: "旧内容\n  保留缩进",
    replace: "新内容\n  保留缩进",
  };
  assert.deepEqual(extractBeforeAfter(input), { before: input.search, after: input.replace });
  for (const source of [
    { toolName: "edit_file", kind: "edit_file", input },
    { toolName: "edit_file", kind: "edit_file", raw: { input } },
  ]) {
    const [summary] = buildFallbackRawToolCallFileSummary(source);
    assert.ok(summary?.patch?.includes("-旧内容"));
    assert.ok(summary.patch.includes("+新内容"));
  }
});
test("删除和空白是有效内容，缺字段不构造差异", () => {
  for (const [before, after] of [
    ["删除这行", ""],
    ["", "新建行"],
    ["  ", "\t"],
  ]) {
    assert.deepEqual(extractBeforeAfter({ search: before, replace: after }), { before, after });
    assert.deepEqual(extractBeforeAfter({ old_string: before, new_string: after }), {
      before,
      after,
    });
  }
  assert.equal(extractBeforeAfter({ search: "只搜索" }), null);
  assert.equal(extractBeforeAfter({ search: "x", replace: null }), null);
});
test("原生写入有内容预览，读取和搜索不误判为写入", () => {
  const [write] = buildFallbackRawToolCallFileSummary({
    kind: "write_file",
    input: { path: "D:/test/new.txt", content: "新文件" },
  });
  assert.equal(write?.operationKind, "write");
  assert.ok(write.patch?.includes("+新文件"));
  for (const kind of ["read_file", "search_files"])
    assert.deepEqual(
      buildFallbackRawToolCallFileSummary({
        kind,
        input: { path: "D:/test/new.txt", search: "x", replace: "y", content: "new" },
      }),
      [],
    );
  const [edit] = buildFallbackRawToolCallFileSummary({
    kind: "edit_file",
    title: "delete matching text",
    input: { path: "D:/test/new.txt", search: "delete me", replace: "" },
  });
  assert.equal(edit?.operationKind, "edit");
  assert.ok(edit.patch?.includes("-delete me"));
});
