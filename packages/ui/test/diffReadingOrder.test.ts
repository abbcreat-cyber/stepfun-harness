import test from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedDiff } from "../src/lib/toolDiffPreview.js";

test("替换片段按先删除后新增排列", () => {
  const patch = buildUnifiedDiff("旧标题", "新标题", "test.txt")!;
  assert.ok(patch.indexOf("\n-旧标题") < patch.indexOf("\n+新标题"), patch);
});
test("不同规模和重复行的差异仍能还原修改前后内容", () => {
  const cases = [
    ["", "new"],
    ["old", ""],
    ["a\nx\na", "a\ny\na"],
    ["a\nb\nc", "c\nb\na"],
    [
      Array.from({ length: 300 }, (_, i) => `old-${i}`).join("\n"),
      Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? `new-${i}` : `old-${i}`)).join("\n"),
    ],
  ];
  for (const [before, after] of cases) {
    const patch = buildUnifiedDiff(before!, after!, "test.txt")!;
    const body = patch
      .split("\n")
      .filter(
        (line) => !line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("@@"),
      );
    assert.equal(
      body
        .filter((l) => l.startsWith(" ") || l.startsWith("-"))
        .map((l) => l.slice(1))
        .join("\n"),
      before,
    );
    assert.equal(
      body
        .filter((l) => l.startsWith(" ") || l.startsWith("+"))
        .map((l) => l.slice(1))
        .join("\n"),
      after,
    );
  }
});
