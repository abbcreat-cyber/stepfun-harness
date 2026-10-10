import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { visibleAssistantText } from "../assistant-text.mjs";
import { expandWorkflowCommand } from "../workflow/catalog.mjs";
import { makeSessionSummary } from "../wire-shapes.mjs";

const textOf = message => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");

/** 一次遍历原生分支和投影，稳定 entry 锚点拥有按钮可用性；不按 rowId 猜原生位置。 */
export async function syncForkActions(ctx, branch) {
  const nativeUsers = [], byId = new Map();
  let turn;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    if (entry.message?.role === "user") {
      if (turn) turn.nextUserId = entry.id;
      turn = { user: entry, text: textOf(entry.message), index: nativeUsers.length }; nativeUsers.push(turn); byId.set(entry.id, turn);
    } else if (entry.message?.role === "assistant" && turn) turn.assistant = entry;
  }
  const rows = ctx.conversationRows, finalByTurn = new Map(), headers = new Map();
  for (const row of rows) {
    if (row.kind === "assistantText") { finalByTurn.set(row.turnId, row); if (row.actions) delete row.actions.canFork; }
    if (row.kind === "turnHeader") headers.set(row.turnId, row);
  }
  const anchors = {}, users = rows.filter(r => r.kind === "userInput" && r.origin === "realUser");
  let cursor = nativeUsers.length - 1;
  for (let i = users.length - 1; i >= 0; i--) {
    const user = users[i]; let native = byId.get(user.entityId);
    if (!native) {
      let text = user.text;
      try { if (user.attachments?.length) text = (await ctx.attachmentStore.prepare(ctx.primarySession.sessionId, user.attachments, text)).text; }
      catch { continue; }
      text = expandWorkflowCommand(text);
      while (cursor >= 0 && nativeUsers[cursor].text !== text) cursor--;
      if (cursor < 0) continue;
      native = nativeUsers[cursor--]; user.entityId = native.user.id;
    } else cursor = Math.min(cursor, native.index - 1);
    const row = finalByTurn.get(user.turnId), assistant = native.assistant;
    if (!row || anchors[row.rowId] || headers.get(user.turnId)?.state !== "completedSuccess" || !assistant) continue;
    const parts = (Array.isArray(assistant.message.content) ? assistant.message.content : []).filter(p => p.type === "text");
    const visible = visibleAssistantText(row.text ?? "").trim();
    if (!visible || ![textOf(assistant.message), parts.at(-1)?.text ?? ""].some(t => visibleAssistantText(t).trim() === visible)) continue;
    row.entityId ||= `${native.user.id}:assistant:${row.rowId}`;
    row.actions = { ...row.actions, canFork: true };
    anchors[row.rowId] = { entityId: row.entityId, assistantEntryId: assistant.id, userEntryId: native.user.id };
  }
  ctx.primarySession.forkTargets = anchors;
  ctx.primarySession.historyActionsVersion = 2;
}

async function copyAttachments(ctx, parentId, childId, rows) {
  const copied = new Set(), replacements = [];
  for (const row of rows) for (const attachment of row.kind === "userInput" ? row.attachments ?? [] : []) {
    if (!/^step-attachment:[a-f0-9]{64}$/.test(attachment.ref) || copied.has(attachment.ref)) continue;
    copied.add(attachment.ref);
    const source = await ctx.attachmentStore.source(parentId, attachment);
    const dir = ctx.attachmentStore.directory(childId), parentDir = ctx.attachmentStore.directory(parentId);
    await mkdir(dir, { recursive: true });
    await cp(source.path, join(dir, `${source.id}.bin`));
    await cp(join(parentDir, `${source.id}.json`), join(dir, `${source.id}.json`));
    // 文档在原生 user 正文里引用已物化文件；重新物化并仅重写这一段已知附件路径。
    const prepared = await ctx.attachmentStore.prepare(childId, [attachment]);
    for (const file of prepared.files) replacements.push([join(parentDir, file.path.slice(dir.length + 1)), file.path]);
  }
  return replacements;
}

export async function forkAssistant(ctx, row, envelope, branch) {
  const anchor = ctx.primarySession.forkTargets?.[row.rowId];
  if (!row.actions?.canFork || !anchor || anchor.entityId !== row.entityId) throw new Error("该回复暂时无法分叉，请重新加载会话");
  const index = branch.findIndex(e => e.id === anchor.assistantEntryId && e.message?.role === "assistant");
  if (index < 0) throw new Error("分叉位置已失效，请重新加载会话");
  const nextUser = branch.slice(index + 1).find(e => e.message?.role === "user");
  const parent = ctx.primarySession, parentFile = parent.stepSessionFile;
  if (!parentFile || parent.readOnly) throw new Error("当前会话无法分叉");
  const childId = `step-session_${randomUUID()}`, file = ctx.conversationFile(childId);
  const childRows = structuredClone(ctx.conversationRows.slice(0, ctx.conversationRows.indexOf(row) + 1));
  for (const item of childRows) {
    if (item.actions) { delete item.actions.canEdit; delete item.actions.canRetry; delete item.actions.canRewindFiles; }
    // 分叉只复制对话；历史文件操作不应变成子会话可以执行的撤销操作。
    if (item.kind === "turnHeader") delete item.fileChanges;
  }
  let childFile, wrote = false;
  try {
    const replacements = await copyAttachments(ctx, parent.sessionId, childId, childRows);
    await ctx.runWithPreparedClient({ selection: null, requireIdle: true }, async client => {
      let failure;
      try {
        const result = await client.request(nextUser ? { type: "fork", entryId: nextUser.id } : { type: "clone" });
        if (!result.success || result.data?.cancelled) throw new Error(result.error || "分叉已取消");
        childFile = (await client.getState()).sessionFile;
        if (!childFile || childFile === parentFile) throw new Error("底座未创建独立的分叉文件");
      } catch (error) { failure = error; }
      try {
          const restored = await client.request({ type: "switch_session", sessionPath: parentFile });
          if (!restored.success || restored.data?.cancelled) throw new Error("恢复原会话失败");
      } catch (error) {
          await client.stop(); ctx.client = null; ctx.clientStartPromise = null; ctx.primarySession = null; ctx.conversationRows = [];
          throw error;
      }
      if (failure) throw failure;
    });
    if (replacements.length) {
      const lines = (await readFile(childFile, "utf8")).trimEnd().split("\n").map(line => {
        const entry = JSON.parse(line);
        if (entry.message?.role === "user") for (const part of Array.isArray(entry.message.content) ? entry.message.content : []) {
          if (part.type !== "text" || !part.text.includes("用户附带的文件")) continue;
          for (const [from, to] of replacements) part.text = part.text.replaceAll(JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1));
        }
        return JSON.stringify(entry);
      });
      await writeFile(childFile, lines.join("\n") + "\n");
    }
    const session = { ...structuredClone(parent), sessionId: childId, stepSessionFile: childFile, createdAt: Date.now(), title: `${parent.title || "对话"} · 分叉`, titleSource: "custom", forkedFrom: { sessionId: parent.sessionId, rowId: row.rowId }, inheritedRowMax: row.rowId, historyActionsVersion: 0 };
    delete session.forkTargets;
    const temp = `${file}.${process.pid}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    try { await writeFile(temp, JSON.stringify({ session, rows: childRows, queueEntries: [] })); await rename(temp, file); wrote = true; }
    finally { await rm(temp, { force: true }); }
    const workspace = parent.workspace, workspaceId = workspace.workspaceKey ?? workspace.workspaceIdentity ?? workspace.workspacePath;
    ctx.persistSessionSummary(workspaceId, makeSessionSummary({ sessionId: childId, workspaceId, title: session.title, phase: "completedSuccess", sessionEnded: false, hasBackgroundWork: false, lastActivityAt: Date.now(), createdAt: session.createdAt }), Boolean(workspace.workspaceIdentity), true);
    ctx.pushPersistedUpserts();
    return { type: "forkAssistant", sessionId: childId };
  } catch (error) {
    if (wrote) await rm(file, { force: true });
    // 目标目录由本次随机 childId 派生，不触及父会话附件。
    await rm(ctx.attachmentStore.directory(childId), { recursive: true, force: true });
    throw error;
  }
}
