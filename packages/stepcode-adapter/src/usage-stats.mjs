import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const count = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
const dayOffset = (day, offset) => new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
export const workspaceKey = (value) => String(value).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();

function usageMessageEntry(entry) {
  const message = entry?.type === "message" && entry.message;
  if (!message) return null;
  const usage = message.usage;
  // 聚合不使用正文/思考/工具输出；解析后立即丢弃这些大字段，避免跨会话累计驻留。
  return { type: "message", id: entry.id, timestamp: entry.timestamp, message: {
    role: message.role, model: message.model, toolName: message.toolName,
    isError: message.isError, stopReason: message.stopReason,
    usage: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite, reasoning: usage.reasoning, totalTokens: usage.totalTokens } : undefined,
  } };
}

/** 原生账本是唯一事实源；不从文本长度估算，也不重复累加同一 entry。 */
export async function readUsageSessions(root, workspaces) {
  const allowed = new Set(workspaces.map(workspaceKey));
  const sessions = [];
  let directories;
  try { directories = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    for (const file of await readdir(join(root, directory.name))) {
      if (!file.endsWith(".jsonl")) continue;
      const lines = (await readFile(join(root, directory.name, file), "utf8")).split("\n");
      const entries = [];
      let firstRecord = true;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          const entry = JSON.parse(lines[i]);
          if (firstRecord) {
            entries.push({ type: entry?.type, id: entry?.id, cwd: entry?.cwd });
            firstRecord = false;
          } else {
            if (entry === null) { entries.push(null); continue; }
            const projected = usageMessageEntry(entry);
            if (projected) entries.push(projected);
          }
        }
        catch (error) { if (i < lines.length - 1) throw error; }
      }
      if (entries[0]?.type === "session" && allowed.has(workspaceKey(entries[0].cwd))) sessions.push(entries);
    }
  }
  return sessions;
}

export function buildUsageSnapshot(sessions, { range = "7d", timeZone = "Asia/Shanghai" } = {}, now = Date.now()) {
  if (!["all", "7d", "30d"].includes(range)) throw new Error("invalid usage range");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateOf = (time) => formatter.format(new Date(time));
  const today = dateOf(now);
  const start = range === "all" ? "0000-01-01" : dayOffset(today, range === "7d" ? -6 : -29);
  const days = new Map(), models = new Map(), tools = new Map(), seen = new Set(), sessionIds = new Set();
  const summary = { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    cacheHitRate: 0, totalSessions: 0, totalTurns: 0, toolCallCount: 0, toolErrorRate: 0, modelErrorRate: 0,
    avgTimeToFirstTokenMs: null, avgTurnDurationMs: null, activeDays: 0, currentStreakDays: 0, longestSessionMs: 0,
    longestStreakDays: 0, peakDayTokens: 0, favoriteModel: null };
  let requests = 0, errors = 0;
  for (const entries of sessions) {
    const sessionId = entries[0].id;
    let firstTime = Infinity, lastTime = -Infinity;
    for (const entry of entries) {
      if (entry.type !== "message" || !entry.message) continue;
      const time = Date.parse(entry.timestamp);
      if (!Number.isFinite(time) || time > now) continue;
      const date = dateOf(time);
      if (date < start || date > today) continue;
      const key = `${sessionId}/${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key); sessionIds.add(sessionId);
      // 不把长会话的全部时间展开为函数参数，避免大账本触发调用栈上限。
      firstTime = Math.min(firstTime, time); lastTime = Math.max(lastTime, time);
      const day = days.get(date) ?? { date, level: 0, totalTokens: 0, turnCount: 0, toolCallCount: 0, models: new Map() };
      days.set(date, day);
      const message = entry.message;
      if (message.role === "user") { summary.totalTurns++; day.turnCount++; }
      if (message.role === "toolResult") {
        const name = message.toolName ?? "unknown";
        const tool = tools.get(name) ?? { toolName: name, callCount: 0, errorCount: 0, errorRate: 0, avgDurationMs: null };
        tool.callCount++; tool.errorCount += message.isError ? 1 : 0;
        tools.set(name, tool); summary.toolCallCount++; day.toolCallCount++;
      }
      if (message.role !== "assistant" || !message.usage) continue;
      const usage = message.usage;
      const input = count(usage.input), output = count(usage.output), read = count(usage.cacheRead), write = count(usage.cacheWrite);
      const total = Number.isFinite(usage.totalTokens) ? count(usage.totalTokens) : input + output + read + write;
      summary.totalTokens += total; summary.inputTokens += input; summary.outputTokens += output;
      summary.cacheReadTokens += read; summary.cacheCreationTokens += write; summary.reasoningTokens += count(usage.reasoning);
      requests++; errors += message.stopReason === "error" ? 1 : 0; day.totalTokens += total;
      const modelId = message.model ?? null;
      const model = models.get(modelId) ?? { modelId, totalTokens: 0, inputTokens: 0, outputTokens: 0, requestCount: 0, share: 0 };
      model.totalTokens += total; model.inputTokens += input; model.outputTokens += output; model.requestCount++;
      models.set(modelId, model); day.models.set(modelId, (day.models.get(modelId) ?? 0) + total);
    }
    if (firstTime !== Infinity) summary.longestSessionMs = Math.max(summary.longestSessionMs, lastTime - firstTime);
  }
  const activeDates = [...days.keys()].sort();
  let streak = 0, previous;
  for (const date of activeDates) { streak = previous && dayOffset(previous, 1) === date ? streak + 1 : 1; summary.longestStreakDays = Math.max(streak, summary.longestStreakDays); previous = date; }
  let cursor = days.has(today) ? today : dayOffset(today, -1);
  while (days.has(cursor)) { summary.currentStreakDays++; cursor = dayOffset(cursor, -1); }
  summary.totalSessions = sessionIds.size; summary.activeDays = days.size;
  summary.peakDayTokens = Math.max(0, ...[...days.values()].map((day) => day.totalTokens));
  const cacheBase = summary.inputTokens + summary.cacheReadTokens + summary.cacheCreationTokens;
  summary.cacheHitRate = cacheBase ? summary.cacheReadTokens / cacheBase : 0;
  summary.modelErrorRate = requests ? errors / requests : 0;
  const toolValues = [...tools.values()];
  for (const tool of toolValues) tool.errorRate = tool.errorCount / tool.callCount;
  summary.toolErrorRate = summary.toolCallCount ? toolValues.reduce((sum, tool) => sum + tool.errorCount, 0) / summary.toolCallCount : 0;
  const modelValues = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  for (const model of modelValues) model.share = summary.totalTokens ? model.totalTokens / summary.totalTokens : 0;
  if (modelValues.length) summary.favoriteModel = { modelId: modelValues[0].modelId, totalTokens: modelValues[0].totalTokens, share: modelValues[0].share };
  const first = range === "all" ? (activeDates[0] ?? today) : start;
  const dailyModelUsage = [], weeks = [];
  let week = { weekIndex: 0, days: Array(new Date(`${first}T12:00:00Z`).getUTCDay()).fill(null) };
  for (let date = first; date <= today; date = dayOffset(date, 1)) {
    const day = days.get(date);
    dailyModelUsage.push({ date, models: [...(day?.models ?? [])].map(([modelId, totalTokens]) => ({ modelId, totalTokens })) });
    week.days.push({ date, totalTokens: day?.totalTokens ?? 0, turnCount: day?.turnCount ?? 0, toolCallCount: day?.toolCallCount ?? 0,
      level: day?.totalTokens ? Math.max(1, Math.ceil(day.totalTokens / summary.peakDayTokens * 4)) : 0 });
    if (week.days.length === 7) { weeks.push(week); week = { weekIndex: weeks.length, days: [] }; }
  }
  if (week.days.length) { while (week.days.length < 7) week.days.push(null); weeks.push(week); }
  return { range, generatedAt: now, timeZone, source: "agent-db", summary,
    heatmap: { startDate: first, endDate: today, maxTokens: summary.peakDayTokens, weeks }, dailyModelUsage, models: modelValues, tools: toolValues };
}
