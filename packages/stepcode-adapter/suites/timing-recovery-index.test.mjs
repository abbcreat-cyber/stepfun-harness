import test from "node:test";
import assert from "node:assert/strict";
import { SessionStatistics } from "../src/session-statistics.mjs";

const stamp = (ms) => new Date(1700000000000 + ms).toISOString();
const entry = (id, ms, model = "model", provider = "provider") => ({
  type: "message",
  id,
  timestamp: stamp(ms),
  message: {
    role: "assistant",
    model,
    provider,
    content: [{ type: "text", text: id }],
    usage: { output: 10 },
  },
});
const event = (id, ms, duration = 100, model = "model", provider = "provider") => ({
  eventId: id,
  at: stamp(ms),
  properties: { model, provider, duration_ms: duration, ttft_ms: 20 },
});

test("长历史计时恢复只解析每条时间一次，不按消息数乘事件数重复解析", () => {
  const entries = Array.from({ length: 500 }, (_, i) => entry(`m${i}`, i * 1000));
  const events = entries.map((_, i) => event(`e${i}`, i * 1000));
  const original = Date.parse;
  let parses = 0;
  Date.parse = (...args) => {
    parses++;
    return original(...args);
  };
  const stats = new SessionStatistics();
  try {
    stats.recoverTimings(entries, events);
  } finally {
    Date.parse = original;
  }
  assert.equal(stats.totals.timedSteps, 500);
  assert.equal(stats.totals.modelMs, 50000);
  assert.ok(parses <= 1000, `Date.parse calls: ${parses}`);
  const before = stats.serialize();
  parses = 0;
  Date.parse = (...args) => {
    parses++;
    return original(...args);
  };
  try {
    stats.recoverTimings(entries, events);
  } finally {
    Date.parse = original;
  }
  assert.equal(parses, 500, "已恢复的消息不再构建事件索引");
  assert.deepEqual(stats.serialize(), before);
});

// 独立保留旧的全表筛选规则作为差分 oracle，不依赖新索引的分桶实现。
function expected(entries, events) {
  const used = new Set();
  let steps = 0,
    ms = 0,
    ttft = 0,
    samples = 0,
    decodeMs = 0,
    decodeTokens = 0;
  for (const e of entries) {
    const ended = Date.parse(e.timestamp);
    const c = events
      .filter(
        (x) =>
          !used.has(x.eventId) &&
          x.properties?.model === e.message.model &&
          x.properties?.provider === e.message.provider &&
          Math.abs(Date.parse(x.at) - ended) <= 250,
      )
      .sort((a, b) => Math.abs(Date.parse(a.at) - ended) - Math.abs(Date.parse(b.at) - ended))[0];
    if (!c || !Number.isFinite(c.properties.duration_ms) || c.properties.duration_ms < 0) continue;
    used.add(c.eventId);
    steps++;
    ms += c.properties.duration_ms;
    const first = c.properties.ttft_ms;
    if (Number.isFinite(first) && first >= 0 && first <= c.properties.duration_ms) {
      ttft += first;
      samples++;
      if (c.properties.duration_ms > first) {
        decodeMs += c.properties.duration_ms - first;
        decodeTokens += 10;
      }
    }
  }
  return { steps, ms, ttft, samples, decodeMs, decodeTokens };
}

test("计时索引与旧规则保持最近匹配、同距顺序、坏值、供应商隔离及重复 ID 语义", () => {
  let seed = 3724;
  const random = (n) => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed % n;
  };
  for (let run = 0; run < 150; run++) {
    const entries = Array.from({ length: 20 }, (_, i) =>
      entry(`m-${i}`, random(3000), i % 3 ? "a" : undefined, i % 2 ? "p" : "q"),
    );
    const events = Array.from({ length: 70 }, (_, i) =>
      event(
        `e-${i % 63}`,
        random(3000),
        i % 7 ? random(400) : -1,
        i % 3 ? "a" : undefined,
        i % 2 ? "p" : "q",
      ),
    );
    events.push({ ...event("invalid", 0), at: "invalid" });
    const want = expected(entries, events),
      s = new SessionStatistics();
    s.recoverTimings(entries, events);
    assert.deepEqual(
      {
        steps: s.totals.timedSteps,
        ms: s.totals.modelMs,
        ttft: s.totals.ttftMs,
        samples: s.totals.ttftSamples,
        decodeMs: s.totals.decodeMs,
        decodeTokens: s.totals.decodeTokens,
      },
      want,
    );
  }
  for (const [events, duration] of [
    [[event("late-first", 250, 100), event("early-second", -250, 200)], 100],
    [[event("bad-nearest", 0, -1), event("good-farther", 1, 200)], 0],
    [[event("outside", 251, 200), event("edge", -250, 100)], 100],
  ]) {
    const s = new SessionStatistics();
    s.recoverTimings([entry("m", 0)], events);
    assert.equal(s.totals.modelMs, duration);
  }
});
