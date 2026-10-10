import { makeTurnHeaderRow, nextId } from "../wire-shapes.mjs";
import { log } from "./logging.mjs";

/** 使用原台账准入维护命令；RPC 总结在锁外等待，停止和后续输入仍可到达。 */
export function createCompaction(ctx) {
  function admitCompact(commandId) {
    const duplicate = ctx.activeCompaction?.entry ?? ctx.ledger.managedQueued().find(e => e.kind === "compact");
    if (duplicate) return { ...duplicate, duplicate: true };
    const busy = ctx.turnBusy || ctx.ledger.frozen || ctx.ledger.managedQueued().length > 0;
    const entry = ctx.ledger.begin({ commandId, kind: "compact", text: "/compact", busy, followupMode: "queue", modelSelection: ctx.primarySession.modelSelection });
    entry.managed = true; ctx.ledger.markQueued(commandId);
    ctx.persistConversation(); ctx.broadcastConversationSnapshot(); ctx.scheduleQueueDrain();
    return entry;
  }

  async function dispatchCompact(entry) {
    try {
      await ctx.runWithPreparedClient({ selection: entry.modelSelection, requireIdle: true, selectModel: true }, async client => {
        await ctx.preparePrompt(client, entry.modelSelection, entry.commandId);
        const turnId = nextId("compact"), rowId = ctx.nextRowId();
        const header = { ...makeTurnHeaderRow({ rowId, turnId, state: "running" }), executionKind: "controlOnly", sourceCommandId: entry.commandId };
        ctx.conversationRows.push(header);
        const marker = { rowId: ctx.nextRowId(), turnId, createdAt: Date.now(), createdAtSeq: ctx.nextRowId(),
          kind: "timelineMarker", sourceCommandId: entry.commandId, lane: "assistantWork", marker: { type: "compact", origin: "manual", status: "running" } };
        const operation = { entry, client, cancelled: false, done: null };
        ctx.activeCompaction = operation; ctx.turnBusy = true; ctx.currentTurnId = turnId; ctx.streamProjection = null;
        entry.state = "attributed"; ctx.conversationRows.push(marker);
        operation.done = (async () => {
          let status = "success";
          try {
            ctx.persistConversation(); ctx.broadcastConversationSnapshot(); ctx.persistPrimarySummary(); ctx.broadcastSessionsIndexUpsert();
            const response = await client.request({ type: "compact" }, { timeoutMs: 180000 });
            if (!response.success) throw new Error(response.error ?? "上下文压缩失败");
            const data = response.data ?? {};
            if (Number.isFinite(data.tokensBefore)) marker.marker.tokensBefore = data.tokensBefore;
            if (Number.isFinite(data.estimatedTokensAfter)) marker.marker.tokensAfter = data.estimatedTokensAfter;
          } catch (error) {
            status = operation.cancelled || /compaction cancel/i.test(error.message) ? "cancelled"
              : /^Nothing to compact(?: \(session too small\))?$/i.test(error.message) ? "noop" : "failed";
            if (error.stepTimeout) {
              // 超时不等于原生任务已停：先结束该底座，避免释放槽位后与下个请求重叠。
              await client.stop(); ctx.client = null; ctx.clientStartPromise = null;
            }
            if (status === "failed") { ctx.ledger.holdAll("error"); log(`compact failed: ${error.message}`); }
          } finally {
            try { if (client.isRunning?.() !== false) await ctx.discardPreparedPrompt(client, entry.modelSelection, entry.commandId); }
            catch (error) { status = "failed"; ctx.ledger.holdAll("error"); log(`compact cleanup failed: ${error.message}`); }
            if (ctx.activeCompaction === operation) {
              if (operation.cancelled) status = "cancelled";
              marker.marker.status = status;
              header.state = status === "failed" ? "failed" : status === "cancelled" ? "completedInterrupted" : "completedSuccess";
              header.endedAt = Date.now(); header.activeMs = header.endedAt - header.startedAt;
              ctx.activeCompaction = null; ctx.turnBusy = false;
              ctx.persistConversation(); ctx.broadcastConversationSnapshot(); ctx.persistPrimarySummary(); ctx.broadcastSessionsIndexUpsert();
              ctx.scheduleQueueDrain();
            }
          }
        })();
        operation.done.catch(error => log(`compact settlement failed: ${error.message}`));
      });
    } catch (error) {
      ctx.ledger.holdAll("error"); ctx.persistConversation(); ctx.broadcastConversationSnapshot(); throw error;
    }
  }

  async function stopCompaction() {
    const operation = ctx.activeCompaction;
    if (!operation) return false;
    await operation.client.abort();
    if (ctx.activeCompaction === operation) operation.cancelled = true;
    await operation.done;
    return true;
  }
  return { admitCompact, dispatchCompact, stopCompaction };
}
