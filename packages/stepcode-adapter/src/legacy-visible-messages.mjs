import { visibleConversationRows } from "./assistant-text.mjs";

/** 兼容读端只派生可见正文，索引仍由 Host 原有 task-index writer 负责。 */
export function legacyVisibleMessages(session, inputRows = []) {
  const rows = visibleConversationRows(inputRows), lastReply = new Map(), users = new Map(), messages = [];
  for (const row of rows) if (row.kind === "assistantText") lastReply.set(row.turnId, row);
  let remaining = 200000;
  for (const row of rows) {
    const user = row.kind === "userInput" && row.origin === "realUser";
    const assistant = row.kind === "assistantText" && lastReply.get(row.turnId) === row;
    if ((!user && !assistant) || !row.text?.trim() || remaining <= 0) continue;
    const messageId = row.entityId || `visible-${row.kind}-${row.rowId}`;
    if (user) users.set(row.turnId, messageId);
    const parentMessageId = users.get(row.turnId);
    if (assistant && !parentMessageId) continue;
    const text = row.text.slice(0, remaining); remaining -= text.length;
    const info = { messageId, sessionId: session.sessionId, role: user ? "user" : "assistant", time: { created: row.createdAt }, agent: "step-code" };
    if (assistant) Object.assign(info, { parentMessageId, path: { cwd: session.workspace.workspacePath, root: session.workspace.workspacePath },
      // 这里是正文兼容投影，不重新构造计费账本；实际用量继续由 V4 statistics 提供。
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" });
    messages.push({ info, parts: [{ partId: `${messageId}:text`, sessionId: session.sessionId, messageId, type: "text", text }] });
  }
  return messages;
}
