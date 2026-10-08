import test from "node:test";
import assert from "node:assert/strict";
import { SessionStatistics } from "../src/session-statistics.mjs";
const message = (timestamp, output = 80) => ({
  role: "assistant",
  timestamp,
  content: [{ type: "text", text: "test" }],
  usage: { input: 100, cacheRead: 800, cacheWrite: 100, output },
});
test("session statistics measure actual latency, decode and overlapping tool time", () => {
  const s = new SessionStatistics();
  s.handle({ type: "agent_start" }, 0);
  s.handle({ type: "turn_start" }, 100);
  s.handle(
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } },
    500,
  );
  s.handle({ type: "message_end", message: message(1) }, 1500);
  s.handle({ type: "tool_execution_start", toolCallId: "a" }, 1600);
  s.handle({ type: "tool_execution_start", toolCallId: "b" }, 1700);
  s.handle({ type: "tool_execution_end", toolCallId: "a" }, 2100);
  s.handle({ type: "tool_execution_end", toolCallId: "b" }, 2200);
  const u = s.usage();
  assert.equal(u.statistics.modelMs, 1400);
  assert.equal(u.statistics.averageTtftMs, 400);
  assert.equal(u.statistics.tokensPerSecond, 80);
  assert.equal(u.statistics.toolMs, 1000);
  assert.equal(
    u.cumulative.cacheReadTokens /
      (u.cumulative.inputTokens + u.cumulative.cacheReadTokens + u.cumulative.cacheWriteTokens),
    0.8,
  );
});
test("session statistics survive persistence without duplicate messages or cross-session totals", () => {
  const a = new SessionStatistics();
  a.handle({ type: "agent_start" });
  a.handle({ type: "message_end", message: message(1) });
  const restored = new SessionStatistics(a.serialize());
  restored.handle({ type: "message_end", message: message(1) });
  assert.deepEqual(restored.usage(), a.usage());
  assert.equal(new SessionStatistics().usage().cumulative.outputTokens, 0);
  restored.handle({ type: "message_end", message: message(2, 0) });
  assert.equal(restored.usage().statistics.steps, 2);
  assert.equal(restored.usage().statistics.tokensPerSecond, null);
});
test("historical native usage restores billing but does not invent timings", () => {
  const s = new SessionStatistics();
  assert.equal(new SessionStatistics(s.serialize()).historyLoaded, false);
  const entries = [
    { type: "message", id: "u", message: { role: "user" } },
    { type: "message", id: "a", message: message(1) },
  ];
  s.seed([...entries, ...entries]);
  assert.equal(s.usage().statistics.steps, 1);
  assert.equal(s.usage().statistics.turns, 1);
  assert.equal(s.usage().statistics.modelMs, null);
  assert.equal(s.usage().statistics.averageTtftMs, null);
  assert.equal(s.historyLoaded, true);
});

test("historical telemetry recovers real metrics exactly once and only for its session", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"),
    { join } = await import("node:path"),
    { tmpdir } = await import("node:os");
  const { readSessionTimingHistory } = await import("../src/session-timing-history.mjs");
  const root = await mkdtemp(join(tmpdir(), "step-timing-"));
  const end = "2026-10-05T03:00:02.000Z",
    msg = {
      ...message(1),
      model: "test-model",
      provider: "test-provider",
      content: [{ type: "toolCall", id: "tool-a" }],
    };
  const entries = [
    { type: "session", id: "session-a" },
    { type: "message", id: "a", timestamp: end, message: msg },
    {
      type: "message",
      id: "t",
      timestamp: "2026-10-05T03:00:02.050Z",
      message: { role: "toolResult", toolCallId: "tool-a" },
    },
  ];
  const event = {
    eventId: "e1",
    event: "model_request_completed",
    at: end,
    context: { sessionId: "session-a" },
    properties: { model: "test-model", provider: "test-provider", duration_ms: 2000, ttft_ms: 500 },
  };
  try {
    await writeFile(
      join(root, "events-2026-10-05.jsonl"),
      [event, { ...event, eventId: "foreign", context: { sessionId: "session-b" } }]
        .map(JSON.stringify)
        .join("\n"),
    );
    const events = await readSessionTimingHistory(entries, [root]);
    assert.equal(events.length, 1);
    const s = new SessionStatistics();
    s.seed(entries);
    s.recoverTimings(entries, events);
    const u = s.usage();
    assert.equal(u.statistics.modelMs, 2000);
    assert.equal(u.statistics.averageTtftMs, 500);
    assert.equal(u.statistics.toolMs, 50);
    assert.equal(u.statistics.tokensPerSecond, 80 / 1.5);
    const restored = new SessionStatistics(s.serialize());
    restored.seed(entries);
    restored.recoverTimings(entries, events);
    assert.deepEqual(restored.usage(), u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
