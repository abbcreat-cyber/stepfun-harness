import { BridgeError } from "./errors.mjs";
import { expandWorkflowCommand } from "../workflow/catalog.mjs";
import { checkpointsFor, checkpointPreview, applyCheckpoints, checkpointChanges } from "../file-checkpoints.mjs";
import { syncForkActions, forkAssistant } from "./assistant-fork.mjs";

export function activeEntries(data) {
  const byId = new Map(data.entries.map(e => [e.id, e])), branch = [], visited = new Set();
  let id = data.leafId;
  while (id) {
    const entry = byId.get(id);
    // 用对象集合检测环，保留旧判定语义，避免长分支每一步都扫描已经访问的前缀。
    if (!entry || visited.has(entry)) throw new Error("原生会话分支不完整");
    visited.add(entry);
    branch.push(entry); id = entry.parentId;
  }
  return branch.reverse();
}

/** 历史命令与普通输入共享 worker 串行链；不在 renderer 保存第二份历史。 */
export function createHistoryControls(ctx) {
  async function entries(client) {
    const response = await client.request({ type: "get_entries" });
    if (!response.success) throw new Error(response.error || "读取原生会话历史失败");
    return activeEntries(response.data);
  }
  async function syncHistoryControls() {
    if (!ctx.primarySession || ctx.turnBusy || !ctx.client?.isRunning()) return;
    const branch = await entries(ctx.client);
    const user = branch.findLast(e => e.type === "message" && e.message?.role === "user");
    const row = ctx.conversationRows.findLast(r => r.kind === "userInput" && r.origin === "realUser");
    if (!row || !user) return;
    const content = user.message.content;
    const nativeText = typeof content === "string" ? content : content.filter(p => p.type === "text").map(p => p.text).join("");
    const prepared = await ctx.attachmentStore.prepare(ctx.primarySession.sessionId, row.attachments ?? [], row.text, { materialize: false, includeImages: false });
    // 相同文字也不能猜历史位置：只绑定当前原生分支的末条真实 user。
    if (nativeText !== expandWorkflowCommand(prepared.text)) return;
    for (const item of ctx.conversationRows) {
      if (item.actions) { delete item.actions.canEdit; delete item.actions.canRetry; }
    }
    row.entityId = user.id; row.actions = { ...row.actions, canEdit: true, editDisposition: "rewind" };
    const header = ctx.conversationRows.find(r => r.kind === "turnHeader" && r.turnId === row.turnId);
    if (header) {
      header.entityId = user.id;
      const files = checkpointsFor(branch, user.id).filter(f => !f.calls[0].ignored && f.calls[0].before?.hash !== f.calls.at(-1).after);
      if (files.length && header.fileChanges?.state !== "reverted" && !(row.rowId <= ctx.primarySession.inheritedRowMax)) {
        const changes = checkpointChanges(files);
        // 工具中断的 before-only 快照不能生成 0 文件摘要或留下可点击的撤销入口。
        if (changes.files) {
          header.fileChanges = { files: changes.files, additions: changes.additions, deletions: changes.deletions, state: "active" };
          header.actions = { ...header.actions, canRewindFiles: true };
        } else { delete header.fileChanges; delete header.actions?.canRewindFiles; }
      } else if (header.fileChanges?.state !== "reverted") {
        delete header.fileChanges; delete header.actions?.canRewindFiles;
      }
    }
    const assistant = ctx.conversationRows.findLast(r => r.kind === "assistantText" && r.turnId === row.turnId);
    if (assistant) {
      assistant.entityId = `${user.id}:assistant:${assistant.rowId}`;
      assistant.actions = { ...assistant.actions, canRetry: true };
    }
    await syncForkActions(ctx, branch);
    ctx.persistConversation(); ctx.broadcastConversationSnapshot();
  }
  async function hydrateHistoryControls(sessionId) {
    const saved = ctx.readConversation(sessionId);
    if (!saved?.session?.stepSessionFile || saved.session.readOnly) return;
    if (ctx.turnBusy || (ctx.primarySession && ctx.primarySession.sessionId !== sessionId)) return;
    await ctx.restoreSession(sessionId);
    // 打开正在展示的旧会话时准备底座；投影已迁移则不重复扫描整段原生历史。
    if (saved.session.historyActionsVersion === 2) return;
    await syncHistoryControls();
  }
  function guard(params, revision = ctx.stateRevision) {
    if (params.baseLogEpoch !== ctx.logEpoch || params.baseRevision !== revision)
      throw new BridgeError(-32000, "会话已变化，请刷新后重试");
    if (ctx.turnBusy || ctx.ledger.managedQueued().length || ctx.workflowBridge.snapshot(params.sessionId).backgroundWorks?.some(w => w.status === "running"))
      throw new BridgeError(-32000, "请先停止当前任务并处理排队消息，再修改历史");
    const target = params.target ?? params.payload?.target;
    const row = ctx.conversationRows.find(r => r.rowId === target?.rowId && r.entityId === target?.entityId);
    if (!row || !target?.entityId) throw new BridgeError(-32000, "该消息已失效，请刷新后重试");
    return row;
  }
  async function fileRecords(params, revision) {
    const row = guard(params, revision);
    if (row.rowId <= ctx.primarySession.inheritedRowMax) throw new BridgeError(-32000, "分叉继承的历史不能撤销原会话的文件修改");
    const user = ctx.conversationRows.find(r => r.kind === "userInput" && r.turnId === row.turnId && r.entityId);
    if (!user) throw new BridgeError(-32000, "该轮没有可恢复的文件检查点");
    return checkpointsFor(await entries(ctx.client), user.entityId);
  }
  async function fileRewindPreview(params) {
    const revision = ctx.stateRevision;
    await ctx.restoreSession(params.sessionId);
    return checkpointPreview(await fileRecords(params, revision));
  }
  async function fileChanges(params) {
    const revision = ctx.stateRevision;
    await ctx.restoreSession(params.sessionId);
    const row = guard(params, revision);
    const header = ctx.conversationRows.find(r => r.kind === "turnHeader" && r.turnId === row.turnId);
    return { ...checkpointChanges(await fileRecords(params, revision)), state: header?.fileChanges?.state ?? "active" };
  }
  async function historyCommand(envelope, revision) {
    await ctx.restoreSession(envelope.sessionId);
    const row = guard(envelope, revision), type = envelope.type;
    if (type === "forkAssistant") return forkAssistant(ctx, row, envelope, await entries(ctx.client));
    if (type === "setAssistantFeedback") {
      if (row.kind !== "assistantText") throw new Error("只能评价回复");
      const value = envelope.payload.feedback;
      if (value !== null && value !== "like" && value !== "dislike") throw new Error("无效的回复评价");
      if (value === null) delete row.feedback; else row.feedback = value;
      ctx.persistConversation(); ctx.broadcastConversationSnapshot(); return;
    }
    if (type === "applyFileRewind") {
      const restored = await applyCheckpoints(await fileRecords(envelope, revision));
      if (restored.applied) {
        const header = ctx.conversationRows.find(r => r.kind === "turnHeader" && r.turnId === row.turnId);
        const previous = header && structuredClone(header);
        try {
          if (header?.fileChanges) { header.fileChanges.state = "reverted"; delete header.actions?.canRewindFiles; }
          ctx.persistConversation();
        } catch (error) { if (header) Object.assign(header, previous); await restored.undo(); throw error; }
        ctx.broadcastConversationSnapshot();
      }
      return { type, applied: restored.applied, preview: restored.preview, response: restored.applied ? "文件已恢复到该轮执行前" : "文件未回退，请检查冲突" };
    }
    const user = ctx.conversationRows.findLast(r => r.kind === "userInput" && r.origin === "realUser");
    if (!user?.entityId || row.turnId !== user.turnId || (type === "editUserQuery" ? row !== user : row.kind !== "assistantText"))
      throw new BridgeError(-32000, "只能编辑或重试最新的用户轮");
    const text = type === "editUserQuery" ? envelope.payload.newText : user.text;
    const attachments = type === "editUserQuery" ? envelope.payload.attachments ?? user.attachments ?? [] : user.attachments ?? [];
    if (!text?.trim() && !attachments.length) throw new Error("消息不能为空");
    // 附件/模型准备失败必须发生在 fork 前，避免输入尚不可用却已截断历史。
    await ctx.attachmentStore.prepare(envelope.sessionId, attachments, text);
    let restored;
    await ctx.runWithPreparedClient({ selection: ctx.primarySession.modelSelection, requireIdle: true, selectModel: true }, async client => {
      const branch = await entries(client);
      if (branch.findLast(e => e.type === "message" && e.message?.role === "user")?.id !== user.entityId) throw new Error("原生历史已变化，请重新加载");
      if (envelope.payload.workspaceMode === "rewind") {
        if (user.rowId <= ctx.primarySession.inheritedRowMax) throw new BridgeError(-32000, "分叉继承的历史不能撤销原会话的文件修改");
        restored = await applyCheckpoints(checkpointsFor(branch, user.entityId));
        if (!restored.applied) return;
      }
      let forked = false, state;
      const originalSession = structuredClone(ctx.primarySession), originalRows = ctx.conversationRows;
      async function restoreNative() {
        try {
          const recovery = await client.request({ type: "switch_session", sessionPath: originalSession.stepSessionFile });
          if (!recovery.success || recovery.data?.cancelled) throw new Error("无法恢复原分支");
        } catch {
          // 清除 primary 身份，下次命令必须从持久化旧会话恢复，不能在空底座续发。
          await client.stop(); ctx.client = null; ctx.clientStartPromise = null; ctx.primarySession = null; ctx.conversationRows = [];
        }
      }
      try {
        const response = await client.request({ type: "fork", entryId: user.entityId });
        if (!response.success || response.data?.cancelled) throw new Error(response.error || "历史修改已取消");
        forked = true;
        state = await client.getState();
        if (!state.sessionFile) throw new Error("底座未返回新会话文件，无法持久化历史修改");
      } catch (error) {
        // fork 超时的投递状态未知；恢复原 session 后才能继续接收新消息。
        if (forked || error.stepTimeout) await restoreNative();
        await restored?.undo?.(); throw error;
      }
      ctx.primarySession.stepSessionFile = state.sessionFile;
      // 逐行计算避免超长会话展开参数导致原生 fork 成功后抛栈溢出，保留已有高水位。
      ctx.primarySession.rowHighWater = ctx.conversationRows.reduce((maximum, row) => Math.max(maximum, row.rowId), ctx.primarySession.rowHighWater ?? 0);
      const userIndex = ctx.conversationRows.indexOf(user);
      // 插话共享 turn 标签，fork 只撤回最后一条 user；前一条真实输入不能从 UI 消失。
      const hasEarlierInput = ctx.conversationRows.slice(0, userIndex).some(r => r.kind === "userInput" && r.turnId === user.turnId);
      const start = hasEarlierInput ? userIndex : ctx.conversationRows.findIndex(r => r.turnId === user.turnId);
      ctx.conversationRows = ctx.conversationRows.slice(0, start);
      ctx.streamProjection = null; ctx.currentTurnId = null; ctx.streamingText = "";
      try { ctx.persistConversation(); }
      catch (error) {
        ctx.primarySession = originalSession; ctx.conversationRows = originalRows;
        await restoreNative(); await restored?.undo?.(); throw error;
      }
      ctx.broadcastConversationSnapshot();
    });
    if (restored && !restored.applied) return { type: "editUserQuery", disposition: "blocked", sessionId: envelope.sessionId, preview: restored.preview };
    await ctx.admitAndSend({ commandId: envelope.commandId, text, attachments, kind: type });
    return type === "editUserQuery" ? { type, disposition: "rewind", sessionId: envelope.sessionId } : undefined;
  }
  return { syncHistoryControls, hydrateHistoryControls, historyCommand, fileRewindPreview, fileChanges };
}
