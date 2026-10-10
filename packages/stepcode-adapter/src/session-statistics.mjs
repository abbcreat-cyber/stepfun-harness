import { createHash } from "node:crypto";

const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
const identity = (message) =>
  createHash("sha256")
    .update(
      JSON.stringify(message, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest("hex");
const empty = () => ({
  turns: 0,
  steps: 0,
  toolCalls: 0,
  modelMs: 0,
  toolMs: 0,
  timedSteps: 0,
  timedTools: 0,
  ttftMs: 0,
  ttftSamples: 0,
  decodeMs: 0,
  decodeTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** 当前会话的统计唯一写入者；时间来自原始事件，不由 UI 或文本长度估算。 */
export class SessionStatistics {
  constructor(saved) {
    this.historyLoaded = saved?.version === 1 && saved.historyLoaded !== false;
    this.totals = empty();
    if (saved?.version === 1)
      for (const key of Object.keys(this.totals)) this.totals[key] = count(saved.totals?.[key]);
    this.seen = new Set(saved?.version === 1 ? (saved.seen ?? []) : []);
    this.timedMessages = new Set(
      saved?.timedMessages ?? (this.totals.timedSteps > 0 ? [...this.seen] : []),
    );
    this.timedToolIds = new Set(saved?.timedToolIds ?? []);
    this.legacyToolTimings = !saved?.timedToolIds && this.totals.timedTools > 0;
    this.tools = new Map();
    this.completedTools = new Set();
    this.start = null;
    this.first = null;
  }
  addMessage(message) {
    const key = identity(message);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const u = message.usage ?? {},
      t = this.totals;
    t.steps++;
    t.inputTokens += count(u.input);
    t.outputTokens += count(u.output);
    t.cacheReadTokens += count(u.cacheRead);
    t.cacheWriteTokens += count(u.cacheWrite);
    return true;
  }
  seed(entries) {
    this.historyLoaded = true;
    let turns = 0,
      tools = 0;
    const ids = new Set();
    for (const entry of entries) {
      if (entry.type !== "message" || !entry.message || ids.has(entry.id)) continue;
      if (entry.id) ids.add(entry.id);
      const message = entry.message;
      if (message.role === "assistant") this.addMessage(message);
      if (message.role === "user") turns++;
      if (message.role === "toolResult") tools++;
    }
    this.totals.turns = Math.max(this.totals.turns, turns);
    this.totals.toolCalls = Math.max(this.totals.toolCalls, tools);
  }
  handle(event, now = Date.now()) {
    const t = this.totals;
    switch (event.type) {
      case "agent_start":
        t.turns++;
        return true;
      case "turn_start":
        this.start = now;
        this.first = null;
        return false;
      case "message_update": {
        const part = event.assistantMessageEvent;
        if (
          this.start !== null &&
          this.first === null &&
          part?.type?.endsWith("_delta") &&
          typeof part.delta === "string" &&
          part.delta.length
        )
          this.first = now;
        return false;
      }
      case "message_end": {
        if (event.message?.role !== "assistant" || !this.addMessage(event.message)) return false;
        if (this.start !== null) {
          t.modelMs += Math.max(0, now - this.start);
          t.timedSteps++;
          this.timedMessages.add(identity(event.message));
        }
        if (this.start !== null && this.first !== null) {
          t.ttftMs += Math.max(0, this.first - this.start);
          t.ttftSamples++;
          const elapsed = now - this.first,
            output = count(event.message.usage?.output);
          if (elapsed > 0 && output > 0) {
            t.decodeMs += elapsed;
            t.decodeTokens += output;
          }
        }
        this.start = null;
        this.first = null;
        return true;
      }
      case "tool_execution_start": {
        if (
          !event.toolCallId ||
          this.tools.has(event.toolCallId) ||
          this.completedTools.has(event.toolCallId)
        )
          return false;
        t.toolCalls++;
        this.tools.set(event.toolCallId, now);
        return true;
      }
      case "tool_execution_end": {
        const began = this.tools.get(event.toolCallId);
        if (began === undefined) return false;
        t.toolMs += Math.max(0, now - began);
        t.timedTools++;
        this.timedToolIds.add(event.toolCallId);
        this.tools.delete(event.toolCallId);
        this.completedTools.add(event.toolCallId);
        return true;
      }
      case "agent_settled":
        this.start = null;
        this.first = null;
        this.tools.clear();
        return true;
      default:
        return false;
    }
  }
  recoverTimings(entries, events) {
    const used = new Set(),
      calls = new Map(),
      t = this.totals;
    // 每次恢复只解析一次计时事件；按供应商、模型和时间分桶，避免逐消息扫描整个账本。
    let timingBuckets;
    for (const entry of entries) {
      const message = entry.message,
        ended = Date.parse(entry.timestamp);
      if (!message || !Number.isFinite(ended)) continue;
      if (message.role === "assistant") {
        for (const part of message.content ?? [])
          if (part.type === "toolCall" && part.id) calls.set(part.id, ended);
        const key = identity(message);
        if (this.timedMessages.has(key)) continue;
        // 已恢复完整时不建索引，保留热会话不扫描 telemetry 的路径。
        if (!timingBuckets) {
          timingBuckets = new Map();
          for (const [order, event] of events.entries()) {
            const at = Date.parse(event.at);
            if (!Number.isFinite(at)) continue;
            const provider = event.properties?.provider,
              model = event.properties?.model;
            if (!timingBuckets.has(provider)) timingBuckets.set(provider, new Map());
            const models = timingBuckets.get(provider);
            if (!models.has(model)) models.set(model, new Map());
            const buckets = models.get(model),
              bucket = Math.floor(at / 250);
            if (!buckets.has(bucket)) buckets.set(bucket, []);
            buckets.get(bucket).push({ event, at, order });
          }
        }
        const buckets = timingBuckets.get(message.provider)?.get(message.model);
        const bucket = Math.floor(ended / 250);
        let best,
          distance = Infinity;
        for (let offset = -1; offset <= 1; offset++) {
          for (const item of buckets?.get(bucket + offset) ?? []) {
            const delta = Math.abs(item.at - ended);
            if (used.has(item.event.eventId) || delta > 250) continue;
            // 同距离按原输入顺序决胜，与旧版稳定排序一致；坏 duration 仍由下方原规则处理。
            if (delta < distance || (delta === distance && item.order < best.order)) {
              best = item;
              distance = delta;
            }
          }
        }
        const candidate = best?.event;
        if (
          !candidate ||
          !Number.isFinite(candidate.properties.duration_ms) ||
          candidate.properties.duration_ms < 0
        )
          continue;
        used.add(candidate.eventId);
        this.timedMessages.add(key);
        const ms = candidate.properties.duration_ms,
          ttft = candidate.properties.ttft_ms;
        t.modelMs += ms;
        t.timedSteps++;
        if (Number.isFinite(ttft) && ttft >= 0 && ttft <= ms) {
          t.ttftMs += ttft;
          t.ttftSamples++;
          if (ms > ttft && count(message.usage?.output) > 0) {
            t.decodeMs += ms - ttft;
            t.decodeTokens += message.usage.output;
          }
        }
      }
      if (
        message.role === "toolResult" &&
        calls.has(message.toolCallId) &&
        !this.timedToolIds.has(message.toolCallId)
      ) {
        this.timedToolIds.add(message.toolCallId);
        // 历史账本保存的是完整调用消息→结果的区间，包含队列和人工确认等待。
        if (!this.legacyToolTimings && ended >= calls.get(message.toolCallId)) {
          t.toolMs += ended - calls.get(message.toolCallId);
          t.timedTools++;
        }
      }
    }
  }
  serialize() {
    return {
      version: 1,
      historyLoaded: this.historyLoaded,
      totals: { ...this.totals },
      seen: [...this.seen],
      timedMessages: [...this.timedMessages],
      timedToolIds: [...this.timedToolIds],
    };
  }
  usage() {
    const t = this.totals;
    return {
      contextWindow: null,
      cumulative: {
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
      },
      statistics: {
        turns: t.turns,
        steps: t.steps,
        toolCalls: t.toolCalls,
        timedSteps: t.timedSteps,
        modelMs: t.timedSteps ? t.modelMs : null,
        toolMs: t.timedTools ? t.toolMs : null,
        averageTtftMs: t.ttftSamples ? t.ttftMs / t.ttftSamples : null,
        tokensPerSecond: t.decodeMs ? (t.decodeTokens * 1000) / t.decodeMs : null,
      },
    };
  }
}
