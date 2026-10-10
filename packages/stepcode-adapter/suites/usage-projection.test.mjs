import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsageSessions, buildUsageSnapshot } from "../src/usage-stats.mjs";
test("统计读取不保留正文，所有聚合值与完整账本一致，损坏边界保持", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-projection-"));
  try {
    await mkdir(join(root, "workspace"));
    const file = join(root, "workspace/s.jsonl");
    const entry = (id, role, extra = {}) => ({
      type: "message",
      id,
      timestamp: "2026-10-03T16:01:10Z",
      message: { role, content: "UNNEEDED_BODY_".repeat(10000), ...extra },
    });
    const a = entry("a", "assistant", {
      model: "model",
      stopReason: "error",
      usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, reasoning: 2, totalTokens: 38 },
    });
    const entries = [
      { type: "session", id: "s", cwd: "D:/qa" },
      entry("u", "user"),
      a,
      a,
      entry("t", "toolResult", { toolName: "read_file", isError: true }),
      entry("other", "custom"),
      { type: "custom", data: "UNNEEDED_BODY_".repeat(10000) },
    ];
    await writeFile(file, entries.map((x) => JSON.stringify(x)).join("\n") + '\n{"incomplete":');
    const compact = await readUsageSessions(root, ["D:/qa"]);
    assert.equal(compact.length, 1);
    assert.equal(JSON.stringify(compact).includes("UNNEEDED_BODY_"), false);
    for (const timeZone of ["UTC", "Asia/Shanghai"])
      for (const range of ["all", "7d", "30d"])
        assert.deepEqual(
          buildUsageSnapshot(compact, { range, timeZone }, Date.parse("2026-10-04T00:00:00Z")),
          buildUsageSnapshot([entries], { range, timeZone }, Date.parse("2026-10-04T00:00:00Z")),
        );
    assert.deepEqual(await readUsageSessions(root, ["D:/unrelated"]), []);
    await writeFile(file, entries.map((x) => JSON.stringify(x)).join("\n") + "\n{broken}\n");
    await assert.rejects(readUsageSessions(root, ["D:/qa"]), SyntaxError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
