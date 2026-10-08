const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/** HTTP 与 stdio 没有全局先后顺序；真实工具行是准入事实，事件唤醒等待者。 */
export class WorkflowToolAdmission {
  constructor(rows, normalizeName, timeoutMs = 5000) {
    this.rows = rows;
    this.normalizeName = normalizeName;
    this.timeoutMs = timeoutMs;
    this.claimed = new Set();
    this.waiters = new Set();
  }
  take(sessionId, method, params) {
    const expected = canonical(params);
    const row = this.rows(sessionId).find((row) => {
      if (
        row.kind !== "toolCall" ||
        this.normalizeName(row.toolName) !== method ||
        row.status !== "running" ||
        this.claimed.has(`${sessionId}:${row.toolCallId}`)
      )
        return false;
      try {
        return canonical(row.input ?? JSON.parse(row.inputText)) === expected;
      } catch {
        return false;
      }
    });
    if (!row) return;
    this.claimed.add(`${sessionId}:${row.toolCallId}`);
    return row.toolCallId;
  }
  claim(sessionId, method, params) {
    const id = this.take(sessionId, method, params);
    if (id) return Promise.resolve(id);
    return new Promise((resolve, reject) => {
      const waiter = {
        sessionId,
        method,
        params,
        finish: (id, error) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          if (error) reject(error);
          else resolve(id);
        },
      };
      // 这是未收到对应工具事件的失败截止，不用定时重试或放松参数匹配。
      waiter.timer = setTimeout(
        () => waiter.finish(null, new Error("工作流请求没有匹配的工具调用，未执行")),
        this.timeoutMs,
      );
      this.waiters.add(waiter);
    });
  }
  observe(sessionId) {
    for (const waiter of this.waiters) {
      if (waiter.sessionId !== sessionId) continue;
      const id = this.take(sessionId, waiter.method, waiter.params);
      if (id) waiter.finish(id);
    }
  }
  cancel(sessionId) {
    for (const waiter of this.waiters)
      if (!sessionId || waiter.sessionId === sessionId)
        waiter.finish(null, new Error("工作流调用关联已取消，未执行"));
  }
}
