import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUsageSnapshot } from "../src/usage-stats.mjs";

test("usage: 150000 messages compute duration without a spread argument overflow", () => {
  const entries = [{ type: "session", id: "large" }, ...Array.from({ length: 150000 }, (_, i) => ({
    type: "message", id: String(i), timestamp: i === 149999 ? "2026-10-10T00:00:10Z" : "2026-10-10T00:00:00Z", message: { role: "user" },
  }))];
  entries.push({type:"message",id:"0",timestamp:"2026-10-10T01:00:00Z",message:{role:"user"}});
  const result=buildUsageSnapshot([entries],{},Date.parse("2026-10-10T12:00:00Z"));
  assert.equal(result.summary.totalTurns,150000);
  assert.equal(result.summary.longestSessionMs,10000);
});

test("usage: exact token counts, duplicate entries, local days, models and empty range", () => {
  const entries = [{ type: "session", id: "s1" },
    { type: "message", id: "u", timestamp: "2026-10-03T16:01:00Z", message: { role: "user" } },
    { type: "message", id: "a", timestamp: "2026-10-03T16:01:10Z", message: { role: "assistant", model: "step-5", usage: { input: 20, output: 10, cacheRead: 40, totalTokens: 70 } } }];
  const now = Date.parse("2026-10-04T02:00:00Z");
  const result = buildUsageSnapshot([entries, entries], { range: "7d", timeZone: "Asia/Shanghai" }, now);
  assert.equal(result.summary.totalTokens, 70);
  assert.equal(result.summary.totalTurns, 1);
  assert.equal(result.summary.totalSessions, 1);
  assert.equal(result.summary.longestSessionMs, 10000);
  assert.equal(result.summary.cacheHitRate, 2 / 3);
  assert.deepEqual(result.dailyModelUsage.at(-1), { date: "2026-10-04", models: [{ modelId: "step-5", totalTokens: 70 }] });
  assert.equal(result.summary.currentStreakDays, 1);
  assert.equal(buildUsageSnapshot([entries], { range: "7d", timeZone: "UTC" }, now).dailyModelUsage.at(-2).models[0].totalTokens, 70);
  assert.equal(buildUsageSnapshot([], {}, now).summary.totalTokens, 0);
});
