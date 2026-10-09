/*
 * 事件投影（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）：Step 事件 →
 * legacy session/event + v4 conversation 流式 delta 与终态快照。
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import { StepStreamProjection } from "../stream-projection.mjs";
import { InputLedger } from "../input-admission.mjs";
import { visibleConversationRows } from "../assistant-text.mjs";
import { SessionStatistics } from "../session-statistics.mjs";
import {
	makeConversationDeltasFrame,
	makeConversationSnapshot,
	makeConversationSnapshotFrame,
	makeSessionEvent,
	makeStateUpdated,
	makeTurnHeaderRow,
	makeUserInputRow,
	makeWorkspaceConfigSnapshot,
	nextId,
} from "../wire-shapes.mjs";
import { log } from "./logging.mjs";
import { createSnapshotPersistence } from "./snapshot-persistence.mjs";

/** @param {any} ctx 共享桥接状态（primarySession/ledger/notify/workflowBridge 等） */
export function createProjection(ctx) {
	const persistSnapshot = createSnapshotPersistence(ctx);
	function flushStreamDeltas() {
		if (streamFlushTimer) clearTimeout(streamFlushTimer);
		streamFlushTimer = null;
		const deltas = pendingStreamDeltas;
		pendingStreamDeltas = [];
		if (!ctx.primarySession || !deltas.length) return;
		const topic = `conversation/${ctx.primarySession.sessionId}`;
		const subscriptionId = ctx.v4Subscriptions.get(topic);
		if (!subscriptionId) return;
		ctx.conversationSeq += 1;
		ctx.stateRevision += 1;
		ctx.notify("v4/conversation/frame", makeConversationDeltasFrame({
			topic, subscriptionId, fromSeq: 0, toSeq: ctx.conversationSeq, deltas,
		}));
	}
	function queueStreamDeltas(deltas) {
		pendingStreamDeltas.push(...deltas);
		if (deltas.length && !streamFlushTimer) streamFlushTimer = setTimeout(flushStreamDeltas, 30);
	}
	/** 当前 turn 的流式增量缓冲（30ms 合并出帧）。 */
	let pendingStreamDeltas = [];
	let streamFlushTimer = null;

	// ── 事件投影：Step 事件 → legacy session/event + v4 conversation snapshot ──
	function emitSessionEvent(type, payload, turnId) {
		if (!ctx.primarySession) return;
		ctx.eventSeq += 1;
		ctx.notify(
			"session/event",
			makeSessionEvent({ type, sessionId: ctx.primarySession.sessionId, seq: ctx.eventSeq, turnId, payload }),
		);
	}

	function broadcastConversationSnapshot(targetTopic, deliveryKind, targetSubscriptionId) {
		flushStreamDeltas();
		// 无 primarySession 且未指定 topic 时无从确定回帧目标（内部事件路径），维持静默。
		if (!ctx.primarySession && !targetTopic) return;
		// 冷订阅从逐会话文件恢复正文；未知草稿按 topic 返回空快照。订阅与
		// resync 指定 topic 的路径在 primarySession 尚不存在时也必须回帧——壳的 v4 恢复握手
		// 在 ack 后限时等不到该 topic 的帧会 fail-closed（recoveryFrameTimedOut）。
		const topic = targetTopic ?? `conversation/${ctx.primarySession.sessionId}`;
		const subscriptionId = targetSubscriptionId ?? ctx.v4Subscriptions.get(topic);
		if (!subscriptionId) return;
		if (ctx.primarySession && topic === `conversation/${ctx.primarySession.sessionId}`) persistSnapshot();
		const saved = ctx.readConversation(topic.slice("conversation/".length));
		const rowsForFrame = ctx.primarySession && topic === `conversation/${ctx.primarySession.sessionId}` ? ctx.conversationRows : (saved?.rows ?? []);
		const terminalState = rowsForFrame.filter(row => row.kind === "turnHeader").at(-1)?.state;
		const terminalPhase = terminalState === "failed" ? "error" : terminalState === "completedInterrupted" ? "completedInterrupted" : rowsForFrame.length ? "completedSuccess" : "draft";
		const sessionIdForFrame = topic.startsWith("conversation/")
			? topic.slice("conversation/".length)
			: ctx.primarySession?.sessionId ?? topic;
		const frameSession = ctx.primarySession?.sessionId === sessionIdForFrame ? ctx.primarySession : saved?.session;
		ctx.conversationSeq += 1;
		ctx.stateRevision += 1;
		ctx.notify(
			"v4/conversation/frame",
			makeConversationSnapshotFrame({
				deliveryKind,
				topic,
				subscriptionId,
				toSeq: ctx.conversationSeq,
				snapshot: makeConversationSnapshot({
					sessionId: sessionIdForFrame,
					logEpoch: ctx.logEpoch,
					seq: ctx.conversationSeq,
					revision: ctx.stateRevision,
					rows: visibleConversationRows(rowsForFrame),
					...ctx.workflowBridge.snapshot(sessionIdForFrame),
					usage: frameSession?.readOnly ? new SessionStatistics(saved?.statistics).usage() : ctx.sessionStatistics(sessionIdForFrame).usage(),
					readOnly: frameSession?.readOnly === true,
					mode: frameSession?.mode ?? "build",
					phase: (ctx.turnBusy && ctx.primarySession?.sessionId === sessionIdForFrame) || (frameSession?.readOnly && terminalState === "running") ? "running" : terminalPhase,
					// P0-02：队列/路由/跟进模式只对 primary 会话投影（台账为进程内状态）。
					followupMode: frameSession?.followupMode ?? "queue",
					// P0-04（本轮）：config 反映会话实际选型（get_state 回读值），不再静态默认。
					modelSelection: frameSession?.modelSelection,
					thoughtLevel: frameSession?.thoughtLevel,
					inputRouting: ctx.ledger.inputRouting({
						busy: ctx.turnBusy && ctx.primarySession?.sessionId === sessionIdForFrame,
						followupMode: frameSession?.followupMode ?? "queue",
					}),
					queue: ctx.primarySession?.sessionId === sessionIdForFrame ? ctx.ledger.queueState() : {
						items: (saved?.queueEntries ?? []).filter(e => e.state === "queued").map(e => {
							const ledger = new InputLedger(); ledger.restoreQueue([e]); return ledger.queueItems()[0];
						}), autoDrain: false, pauseReason: "manual",
					},
				}),
			}),
		);
	}

	function broadcastWorkspaceConfig(topic, subscriptionId, deliveryKind) {
		ctx.conversationSeq += 1;
		ctx.notify("v4/conversation/frame", makeConversationSnapshotFrame({
			topic, subscriptionId, deliveryKind, toSeq: ctx.conversationSeq,
			snapshot: makeWorkspaceConfigSnapshot({ workspaceId: topic.slice("workspace-config/".length), logEpoch: ctx.logEpoch }),
		}));
	}

	function nextRowId() {
		return ctx.conversationRows.length + 1;
	}

	/** Step 事件在 v4 通道实时增量投影；终态快照用于恢复与持久化。 */
	function projectStepEvent(event) {
		if (!ctx.primarySession || !event || typeof event.type !== "string") return;
		try {
			if (event.type === "step_client_failed") {
				if (!ctx.turnBusy) return;
				if (event.turnId && event.turnId !== ctx.currentTurnId) return;
				if (event.turnId && ctx.conversationRows.some(row => row.kind === "turnHeader" && row.turnId === event.turnId && row.endedAt !== undefined)) return;
				// 进程退出不是 agent_settled，单独投影真实失败；不触发下一条未知投递。
				ctx.ledger.holdAll("error");
				ctx.workflowBridge.cancelPending?.(ctx.primarySession.sessionId);
				if (!event.turnId) {
					// 尚未收到 agent_start 的失败没有实际轮次；不能再次结束上一轮。
					ctx.turnBusy = false; broadcastConversationSnapshot();
					ctx.persistPrimarySummary(); ctx.broadcastSessionsIndexUpsert();
					return;
				}
				if (ctx.streamProjection && ctx.streamProjection.outcome !== "completedInterrupted") ctx.streamProjection.outcome = "failed";
			}
			if (ctx.sessionStatistics(ctx.primarySession.sessionId).handle(event)) queueStreamDeltas([{op:"state.updated",patch:{usage:ctx.sessionStatistics(ctx.primarySession.sessionId).usage()}}]);
			if (ctx.streamProjection) queueStreamDeltas(ctx.streamProjection.handle(event));
			if (["tool_execution_start", "tool_execution_end", "agent_settled"].includes(event.type)) ctx.workflowBridge?.observeTools?.(ctx.primarySession.sessionId);
			switch (event.type) {
				case "agent_start": {
					const activeHeader = ctx.conversationRows.find(row => row.kind === "turnHeader" && row.turnId === ctx.currentTurnId && row.state === "running");
					if (ctx.turnBusy && ctx.streamProjection && activeHeader) {
						// SDK retry/compaction 的 agent_start 不是新的已准入用户输入；
						// agent_settled 前保留同一业务 turn/header，不能再次消费台账。
						break;
					}
					ctx.turnBusy = true;
					ctx.currentTurnId = nextId("turn");
					ctx.streamProjection = new StepStreamProjection(ctx.conversationRows, ctx.currentTurnId, ctx.primarySession.modelSelection?.modelId);
					// 归属（spec §3.4）：最近 submitted（直发 prompt）优先，否则 followUp 池中
					// 仍在的最老 queued（池续跑）。工作流通知直发 prompt 不进台账，不会误归属。
					const attributed = ctx.ledger.attributeNextRun();
					// 原生 goal/follow-up 没有新的 Host ledger 输入；继续沿上一真正输入的权限来源。
					// 新手动输入实际开始时原子替换来源，排队准入与仅有历史文字都不能改变它。
					if (attributed) ctx.primarySession.lastInputTaskContext = {
						sourceCommandId: attributed.commandId, automationId: attributed.automationId,
						toolDisallowlist: attributed.toolDisallowlist, botDeliveryTarget: attributed.botDeliveryTarget,
					};
					const origin = ctx.primarySession.lastInputTaskContext;
					ctx.activeAutomationId = origin?.automationId;
					ctx.activeToolDisallowlist = origin?.toolDisallowlist;
					ctx.activeBotDeliveryTarget = origin?.botDeliveryTarget;
					if (attributed) {
						const existingInput = ctx.conversationRows.find(r => r.kind === "userInput" && r.sourceCommandId === attributed.commandId);
						ctx.conversationRows.push({ ...makeTurnHeaderRow({ rowId: nextRowId(), turnId: ctx.currentTurnId, state: "running" }), sourceCommandId: attributed.commandId });
						if (existingInput) existingInput.turnId = ctx.currentTurnId;
						else ctx.conversationRows.push({ ...makeUserInputRow({ rowId: nextRowId(), turnId: ctx.currentTurnId, text: attributed.text, attachments: attributed.attachments }), sourceCommandId: attributed.commandId });
					}
					emitSessionEvent(
						"turn.started",
						{ turnNumber: ctx.conversationRows.filter((r) => r.kind === "turnHeader").length, input: attributed?.text ?? "" },
						ctx.currentTurnId ?? undefined,
					);
					broadcastConversationSnapshot();
					ctx.persistPrimarySummary(); ctx.broadcastSessionsIndexUpsert();
					break;
				}
				case "queue_update": {
					// 原生池快照：记录 + reconcile（stop 冻结后只记录不动队列，spec §4）。
					ctx.ledger.applyNativeQueue({ steering: event.steering, followUp: event.followUp });
					broadcastConversationSnapshot();
					break;
				}
				case "message_update": {
					const inner = event.assistantMessageEvent;
					if (inner?.type === "text_delta" && typeof inner.delta === "string") {
						ctx.streamingText += inner.delta;
						emitSessionEvent(
							"part.delta",
							{ messageId: ctx.currentTurnId ?? "m", partId: "text", field: "text", delta: inner.delta },
							ctx.currentTurnId ?? undefined,
						);
					}
					break;
				}
				case "message_start": {
					if (event.message?.role !== "user") break;
					const text = Array.isArray(event.message.content) ? event.message.content.filter(p => p.type === "text").map(p => p.text).join("") : event.message.content;
					const entry = [...ctx.ledger.entries.values()].find(e => e.decision.route === "steer" && ["pending", "steered"].includes(e.state) && (e.dispatchedText ?? e.text) === text);
					if (!entry) break;
					// 原生 user 消息才是消费证据；ACK 晚于整轮终态时也不能复活该项。
					entry.state = "attributed";
					if (!ctx.conversationRows.some(r => r.kind === "userInput" && r.sourceCommandId === entry.commandId)) ctx.conversationRows.push({ ...makeUserInputRow({ rowId: nextRowId(), turnId: ctx.currentTurnId, text: entry.text, attachments: entry.attachments }), sourceCommandId: entry.commandId });
					broadcastConversationSnapshot();
					break;
				}
				case "step_client_failed":
				case "agent_settled": {
					ctx.turnBusy = false;
					ctx.activeAutomationId = undefined;
					ctx.activeToolDisallowlist = undefined;
					ctx.activeBotDeliveryTarget = undefined;
					const header = ctx.conversationRows.find((row) => row.kind === "turnHeader" && row.turnId === ctx.currentTurnId);
					if (header) {
						const outcome = ctx.streamProjection?.interruptedByUser ? "completedInterrupted" : ctx.streamProjection?.outcome;
						if (ctx.streamProjection && outcome) ctx.streamProjection.outcome = outcome;
						header.state = outcome ?? (event.type === "step_client_failed" ? "failed" : "completedSuccess");
						header.endedAt = Date.now();
						header.activeMs = header.endedAt - header.startedAt;
					}
					emitSessionEvent(
						"turn.completed",
						{
							response: ctx.streamingText,
							tokenCount: 0,
							toolCallCount: ctx.conversationRows.filter((r) => r.kind === "toolCall").length,
							duration: 0,
							// legacy 与 V4 共用真实终态，错误/取消不能重新投影成成功。
							resultType: ctx.streamProjection?.outcome === "completedInterrupted" ? "cancelled" : ctx.streamProjection?.outcome === "failed" || event.type === "step_client_failed" ? "error_during_execution" : "success",
						},
						ctx.currentTurnId ?? undefined,
					);
					ctx.streamingText = "";
					// turn 终态：steer 并入项随本 turn 退场（近似记录完成）；已归属项在
					// agent_start 时已消费，无单槽可清（spec §4 settleTurn）。
					ctx.ledger.settleTurn();
					ctx.scheduleQueueDrain();
					ctx.stateRevision += 1;
					broadcastConversationSnapshot();
					// turn 终态：会话标题（首条用户消息）与 lastActivityAt 都可能变化，再 upsert 一次，
					// 否则侧栏相对时间永远停在创建时刻。落盘同样刷新（标题/时间给跨进程读取方）。
					ctx.persistPrimarySummary();
					ctx.broadcastSessionsIndexUpsert();
					ctx.notify(
						"state.updated",
						makeStateUpdated({ sessionId: ctx.primarySession.sessionId, revision: ctx.stateRevision }),
					);
					break;
				}
				default:
					// 其余 Step 事件（bash_execution_update 等）MVP 不投影。
					break;
			}
		} catch (error) {
			log(`event projection failed:`, error?.stack ?? error);
		}
	}

	return { flushStreamDeltas, queueStreamDeltas, emitSessionEvent, broadcastConversationSnapshot, broadcastWorkspaceConfig, nextRowId, projectStepEvent };
}
