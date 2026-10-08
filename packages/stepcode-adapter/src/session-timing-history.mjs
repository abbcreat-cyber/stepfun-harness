import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 只读取账本覆盖日期且 sessionId 精确匹配的计时，绝不借用相邻会话。 */
export async function readSessionTimingHistory(entries, roots) {
  const sessionId = entries.find((e) => e.type === "session")?.id;
  if (!sessionId) return [];
  const dates = new Set(
    entries
      .filter((e) => e.message?.role === "assistant" && typeof e.timestamp === "string")
      .map((e) => e.timestamp.slice(0, 10))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
  );
  const events = new Map();
  for (const root of new Set(roots.filter(Boolean)))
    for (const date of dates) {
      let text;
      try {
        text = await readFile(join(root, `events-${date}.jsonl`), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const line of text.split("\n")) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          event.event === "model_request_completed" &&
          event.context?.sessionId === sessionId &&
          event.eventId
        )
          events.set(event.eventId, event);
      }
    }
  return [...events.values()];
}
