import test from "node:test";
import assert from "node:assert/strict";
import {
  getSearchPrimaryText,
  getSearchResultText,
  getNativeSearchKind,
} from "../src/lib/searchToolPresentation.js";
const intl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
    `${id}:${Object.values(values ?? {}).join("")}`,
};
test("原生目录摘要和 Explore 分类保持一致", () => {
  assert.equal(getNativeSearchKind("list_directory"), "list");
  assert.equal(getNativeSearchKind("find_files"), "list");
  assert.equal(getNativeSearchKind("search_files"), "search");
  assert.equal(getNativeSearchKind("read_file"), null);
  assert.equal(
    getSearchPrimaryText(intl, { path: "D:/中文 #1" }, "list_directory"),
    "chat.toolCall.search.listIn:D:/中文 #1",
  );
  assert.equal(
    getSearchPrimaryText(intl, { path: "D:/root", pattern: "needle" }, "search_files"),
    "chat.toolCall.search.findWithQuery:needle",
  );
  assert.equal(
    getSearchPrimaryText(intl, { url: "https://example.com", prompt: "read it" }),
    "chat.toolCall.search.findWithQuery:https://example.com",
  );
});
test("结果原文、零匹配和旧结构输出可展开，不丢空白", () => {
  assert.equal(getSearchResultText("a:1: 中文\n  b"), "a:1: 中文\n  b");
  assert.equal(getSearchResultText({ text: "(no matches)" }), "(no matches)");
  assert.equal(getSearchResultText(""), "");
  assert.equal(getSearchResultText(undefined), undefined);
  assert.equal(getSearchResultText({ items: [1] }), '{\n  "items": [\n    1\n  ]\n}');
});
