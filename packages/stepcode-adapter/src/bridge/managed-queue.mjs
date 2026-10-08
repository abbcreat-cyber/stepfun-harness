import { BridgeError } from "./errors.mjs";
import { log } from "./logging.mjs";
import { expandWorkflowCommand } from "../workflow/catalog.mjs";
import { acceptedPermissionMode } from "../permission-policy.mjs";
import { classifyStepSendError } from "../step-send-errors.mjs";

/** 单一操作链串行管理桥接台账；原生插话仍由 Step 负责，不复制第二份可执行队列。 */
export function createManagedQueue(ctx) {
 let operations = Promise.resolve();
 function runInputOperation(operation) {
  const result = operations.then(operation);
  operations = result.catch(() => {});
  return result;
 }
 async function dispatchQueued(entry) {
  if (!entry || entry.state !== "queued") return;
  // 发请求前先置 submitted，agent_start 早于 RPC ACK 时仍能按 commandId 正确归属。
  entry.state = "submitted";
  ctx.persistConversation();
  let promptSent = false;
  try {
   const images = await ctx.attachmentStore.images(ctx.primarySession.sessionId, entry.attachments);
   const selection = entry.modelSelection ?? ctx.primarySession.modelSelection;
   await ctx.runWithPreparedClient({ selection, requireIdle: true, selectModel: true }, async client => {
   const state = await client.getState();
   if (state.model?.provider && state.model?.id) ctx.primarySession.modelSelection = { providerId: state.model.provider, modelId: state.model.id, ...(selection?.options ? { options: selection.options } : {}) };
   if (state.thinkingLevel) ctx.primarySession.thoughtLevel = state.thinkingLevel;
   ctx.persistConversation();
   ctx.primarySession.mode = acceptedPermissionMode(entry.mode, ctx.primarySession.mode);
   await ctx.hydrateStatistics(ctx.primarySession.sessionId);
   await ctx.preparePrompt(client, selection, entry.commandId);
   ctx.turnBusy = true;
   promptSent = true;
   try { await client.prompt(expandWorkflowCommand(entry.text), { images }); }
   catch (error) {
    if (error.stepRejected === true) {
     ctx.turnBusy = false;
     try { await ctx.discardPreparedPrompt(client, selection, entry.commandId); }
     catch (cleanupError) { cleanupError.stepRejected = true; throw cleanupError; }
    }
    throw error;
   }
   });
  } catch (error) {
   // 仅明确拒绝可重新排队。超时/未知投递保留 submitted，禁止自动重复发送。
   if ((!promptSent || error.stepRejected === true) && entry.state === "submitted") {
    entry.state = "queued";
    ctx.turnBusy = false;
   }
   ctx.ledger.holdAll("error");
   ctx.broadcastConversationSnapshot();
   throw new BridgeError(-32000, classifyStepSendError(error, entry.modelSelection ?? ctx.primarySession.modelSelection));
  }
  ctx.broadcastConversationSnapshot();
 }
 function scheduleQueueDrain() {
  void runInputOperation(async () => {
   if (!ctx.primarySession || ctx.turnBusy || ctx.ledger.frozen) return;
   const entry = ctx.ledger.managedQueued()[0];
   if (entry) await dispatchQueued(entry);
  }).catch(error => log(`queue dispatch failed: ${error.message}`));
 }
 async function stopCurrentTurn() {
  ctx.ledger.holdAll("stopped");
  if (ctx.streamProjection) ctx.streamProjection.outcome = "completedInterrupted";
  ctx.broadcastConversationSnapshot();
  if (!ctx.client?.isRunning()) return;
  // 先订阅终态再 abort，不能用固定 sleep 假装底座已经停止。
  const settled = ctx.turnBusy ? ctx.client.waitForIdle(15000) : null;
  settled?.catch(() => {});
  await ctx.client.abort();
  if (settled) await settled;
 }
 function requireQueued(id) {
  const entry = ctx.ledger.managedQueued().find(e => e.queueItemId === id);
  if (!entry) throw new BridgeError(-32000, "消息已发送或已取消，请刷新队列后重试");
  return entry;
 }
 async function manageQueue(envelope) {
  if (envelope.sessionId !== ctx.primarySession?.sessionId) await ctx.restoreSession(envelope.sessionId);
  const payload = envelope.payload ?? {};
  switch (envelope.type) {
   case "deleteQueueItem": requireQueued(payload.queueItemId).state = "cancelled"; break;
   case "editQueueItem": {
    const entry = requireQueued(payload.queueItemId);
    if (typeof payload.newText !== "string" || (!payload.newText.trim() && !entry.attachments.length)) throw new BridgeError(-32602, "消息内容不能为空");
    entry.text = payload.newText; break;
   }
   case "reorderQueueItem": {
    const entry = requireQueued(payload.queueItemId);
    const before = payload.beforeQueueItemId === null ? null : requireQueued(payload.beforeQueueItemId);
    if (before === entry) break;
    const items = ctx.ledger.managedQueued().filter(e => e !== entry);
    items.splice(before ? items.indexOf(before) : items.length, 0, entry);
    items.forEach((e, i) => { e.queuePosition = i + 1; }); break;
   }
   case "setAutoDrain":
    if (typeof payload.autoDrain !== "boolean") throw new BridgeError(-32602, "autoDrain 需要布尔值");
    if (payload.autoDrain) ctx.ledger.resume(); else ctx.ledger.holdAll("manual");
    break;
   case "sendQueuedNow": {
    const entry = requireQueued(payload.queueItemId);
    const paused = ctx.ledger.frozen;
    const pauseReason = ctx.ledger.pauseReason;
    await stopCurrentTurn();
    if (!paused) ctx.ledger.resume(); else ctx.ledger.holdAll(pauseReason ?? "manual");
    await dispatchQueued(entry); break;
   }
  }
  ctx.broadcastConversationSnapshot();
  if (envelope.type === "setAutoDrain" && payload.autoDrain) scheduleQueueDrain();
 }
 return { runInputOperation, scheduleQueueDrain, stopCurrentTurn, manageQueue };
}
