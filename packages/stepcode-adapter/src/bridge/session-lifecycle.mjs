/*
 * 会话生命周期动作（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）：
 * requireSession、restoreSession、统一发送路径 admitAndSend（P0-02）、被拒首发
 * 草稿清理（spec §2，P1-01 起薄委托 session-admin 的 draftCleanup 原语）、
 * 显式模型选择/思考档位落定（P0-04）。
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import { sanitizeModelSelection } from "../input-admission.mjs";
import { expandWorkflowCommand } from "../workflow/catalog.mjs";
import { classifyStepSendError } from "../step-send-errors.mjs";
import { makeUserInputRow } from "../wire-shapes.mjs";
import { log } from "./logging.mjs";
import { BridgeError } from "./errors.mjs";
import { resolveSessionWorkspace } from "./model-admission.mjs";

/** @param {any} ctx 共享桥接状态（ledger/primarySession/client/attachmentStore 等） */
export function createSessionLifecycle(ctx) {
	async function restoreSession(sessionId) {
		if (ctx.primarySession?.sessionId === sessionId) {
			const session = ctx.primarySession, workspace = await resolveSessionWorkspace(ctx, { workspace: session.workspace });
			if (ctx.primarySession !== session) throw new BridgeError(-32000, "会话已切换，请重试");
			session.workspace = workspace;
			ctx.persistConversation();
			return;
		}
		const saved = ctx.readConversation(sessionId);
		if (!saved?.session) throw new BridgeError(-32002, "找不到该会话的本地记录");
		if (ctx.turnBusy) throw new BridgeError(-32000, "当前对话仍在运行");
		const workspace = await resolveSessionWorkspace(ctx, { workspace: saved.session.workspace });
		return ctx.runWithPreparedClient({ selection: null, requireIdle: true, refreshAll: true, sessionId, workspace }, async client => {
		if (saved.session.stepSessionFile) {
			const response = await client.request({ type: "switch_session", sessionPath: saved.session.stepSessionFile });
			if (!response.success || response.data?.cancelled) throw new BridgeError(-32000, "无法恢复 Step 会话");
		}
		ctx.primarySession = saved.session;
		ctx.primarySession.workspace = workspace;
		ctx.conversationRows = saved.rows;
		// 台账生命周期：恢复会话即整体清零（spec §4）。
		ctx.ledger.restoreQueue(saved.queueEntries);
		// 恢复历史允许记录中的模型已下线，但保留选择，下一次发送必须拒绝。
		// 不能用底座默认值覆盖失效选择，否则普通续发会悄悄发送到其他供应商。
		if (saved.session.modelSelection?.providerId && saved.session.modelSelection?.modelId) {
			try {
				await client.setModel(saved.session.modelSelection.providerId, saved.session.modelSelection.modelId);
				if (saved.session.thoughtLevel) await client.setThinkingLevel(saved.session.thoughtLevel);
			} catch (error) {
				log(`恢复会话模型配置不可用（保留选择，等待用户重新选择）: ${error?.message ?? error}`);
			}
			ctx.persistConversation();
		}
		});
	}

	/**
	 * P0-02 统一发送路径（legacy session/send、v4 sendText、createSession firstInput 共用）：
	 * 1) 台账登记先于 RPC 调用（agent_start 投影才能渲染带 sourceCommandId 的 userInput 行）；
	 * 2) 三分流：idle→prompt；busy+queue/缺省→followUp；busy+startNow→steer（近似降级）；
	 *    busy+guide→诚实拒绝；
	 * 3) 失败一律 markFailed + 中文归类抛错（不伪造 ACK），并透传 stepRejected/stepTimeout
	 *    机器可读标记供上层决定清理边界（spec §2）；
	 * 4) 每次准入决策落一行 bridge 日志（branch=direct/queue/steer/reject + commandId +
	 *    delivery + modelDeferred，spec §10）——R6 类场景可从 bridge.log 取证走了哪个分支。
	 * @param {{ commandId: string, text: string, attachments?: any[], mode?: string, modelSelection?: any, modelSelectionExplicit?: boolean, requestedDelivery?: string, followupMode?: string, kind?: string }} input
	 */
	async function admitAndSend({ commandId, text, attachments = [], mode, modelSelection, modelSelectionExplicit = false, requestedDelivery, followupMode, kind = "sendText", clientId, automationId, toolDisallowlist, botDeliveryTarget }) {
		const images = await ctx.attachmentStore.images(ctx.primarySession.sessionId, attachments);
		const explicitSelection = sanitizeModelSelection(modelSelection);
		let selection = explicitSelection ?? ctx.primarySession.modelSelection;
		if (selection && !selection.options && selection.providerId === ctx.primarySession.modelSelection?.providerId && selection.modelId === ctx.primarySession.modelSelection?.modelId && ctx.primarySession.modelSelection.options) selection = { ...selection, options: ctx.primarySession.modelSelection.options };
		// 普通同模型续发也必须经过完整准备；持锁直到 prompt 准入，避免准备后被并发切换。
		return ctx.runWithPreparedClient({ selection, selectModel: true }, async client => {
		if (!ctx.turnBusy && selection) {
			const state = await client.getState();
			if (state.model?.provider && state.model?.id) ctx.primarySession.modelSelection = { providerId: state.model.provider, modelId: state.model.id, ...(selection.options ? { options: selection.options } : {}) };
			if (state.thinkingLevel) ctx.primarySession.thoughtLevel = state.thinkingLevel;
			ctx.persistConversation();
		}
		const entry = ctx.ledger.begin({
			commandId,
			kind,
			clientId,
			text,
			attachments,
			mode,
			automationId, toolDisallowlist, botDeliveryTarget,
			modelSelection: selection,
			modelSelectionExplicit: modelSelectionExplicit && explicitSelection !== undefined,
			requestedDelivery,
			followupMode: followupMode ?? ctx.primarySession.followupMode ?? "queue",
			busy: ctx.turnBusy,
		});
		const currentSelection = ctx.primarySession.modelSelection;
		if (entry.decision.route === "steer" && (automationId || toolDisallowlist?.length || botDeliveryTarget || selection?.providerId !== currentSelection?.providerId || selection?.modelId !== currentSelection?.modelId || JSON.stringify(selection?.options ?? {}) !== JSON.stringify(currentSelection?.options ?? {}))) {
			// 忙轮只能携带同一已生效选择；新选择留在现有台账，空闲后再落定。
			entry.decision = { route: "followUp", delivery: "queue", fallbackReasonCode: "stepcode.community.optionsDeferred" };
		}
		if (entry.decision.route === "followUp") {
			entry.managed = true;
			entry.modelDeferred = false;
		}
		// 准入决策日志（spec §10）：一行、字段制，branch 对应三分流（prompt→direct）。
		// reject 也是准入决策，在抛错前落日志（否则 guide 拒绝场景在 bridge.log 无痕）。
		const branch = entry.decision.route === "prompt" ? "direct"
			: entry.decision.route === "followUp" ? "queue"
				: entry.decision.route;
		log(`admission branch=${branch} commandId=${commandId} delivery=${entry.decision.delivery}${entry.modelDeferred ? " modelDeferred=1" : ""}`);
		if (entry.decision.route === "reject") {
			ctx.ledger.markFailed(commandId);
			throw new BridgeError(-32000, "当前会话处于 guide 跟进模式，桥接未接入 guide 输入通道；请切回 queue 模式后重试");
		}
		try {
			if (entry.decision.route === "followUp") {
				// 原生 follow_up 无按 ID 撤销；只在本 worker 排队，轮到执行才发 prompt。
				entry.managed = true;
				entry.modelDeferred = false;
				entry.queuePosition = Math.max(0, ...ctx.ledger.managedQueued().map(e => e.queuePosition ?? e.admissionSeq)) + 1;
				ctx.ledger.markQueued(commandId);
				ctx.broadcastConversationSnapshot();
				ctx.scheduleQueueDrain();
			} else if (entry.decision.route === "steer") {
				// 判忙到 RPC 到达之间原任务可能结束；裸 steer 会滞留空闲池。
				// prompt 的 streamingBehavior 在底座内裁决：仍忙则插话，已闲则直接开启新轮。
				entry.dispatchedText = expandWorkflowCommand(text);
				// 同选择 transport carry 不改 active；SDK 已转 idle 时也能安全准备新轮。
				await ctx.carryPrompt(client, currentSelection, commandId);
				await client.prompt(entry.dispatchedText, { images, streamingBehavior: "steer" });
				ctx.ledger.markSteered(commandId);
				// agent_start/message_start 可能先于 ACK，已归属的输入不再重复投影。
				// 已闲但新轮尚未开始时留给 agent_start 归属，不能挂到刚结束的旧轮。
				if (entry.state === "steered" && ctx.turnBusy) ctx.conversationRows.push({
					...makeUserInputRow({ rowId: ctx.nextRowId(), turnId: ctx.currentTurnId ?? entry.queueItemId, text, attachments }),
					sourceCommandId: commandId,
				});
				// 新轮 ACK 已接受而 agent_start 尚未送达时也占住运行槽，不能抢先 drain 下一项。
				if (entry.state === "steered") ctx.turnBusy = true;
				ctx.broadcastConversationSnapshot();
			} else {
				await ctx.hydrateStatistics(ctx.primarySession.sessionId);
				await ctx.preparePrompt(client, selection, commandId);
				// prompt ACK 可能先于 agent_start；先占运行槽，下一次发送才不会误判空闲。
				ctx.turnBusy = true;
				await client.prompt(expandWorkflowCommand(text), { images });
				ctx.ledger.markSubmitted(commandId);
			}
		} catch (error) {
			if (entry.decision.route === "prompt" && error?.stepRejected === true && ctx.ledger.isSubmitted(commandId)) ctx.turnBusy = false;
			ctx.ledger.markFailed(commandId);
			if (["prompt", "steer"].includes(entry.decision.route) && error?.stepRejected === true) await ctx.discardPreparedPrompt(client, entry.decision.route === "steer" ? currentSelection : selection, commandId);
			const wrapped = new BridgeError(-32000, classifyStepSendError(error, { ...selection, modelId: selection?.modelId }));
			if (error?.stepRejected === true) wrapped.stepRejected = true;
			if (error?.stepTimeout === true) wrapped.stepTimeout = true;
			throw wrapped;
		}
		return entry;
		}).catch(error => {
			// 准备阶段尚未发送 prompt，也必须保留同样的供应商错误分类。
			if (error instanceof BridgeError) throw error;
			throw new BridgeError(-32000, classifyStepSendError(error, selection));
		});
	}

	/**
	 * 清理被拒首发的空草稿（spec §2）：仅 stepRejected 且 !turnBusy 且 rows===0 时调用。
	 * P1-01 收口为薄委托 session-admin 的 draftCleanup 原语（deleteSession 同一条链）：
	 * 索引过滤+墓碑+unlink 统一走一份代码；清理自身失败仅 log 不掩盖原错、返回 bool
	 * 的契约保持不变。行为统一说明（原实现只清内存态不停 client）：现在与 deleteSession
	 * 一致——primary 草稿被清理时同步 stop 底座 client 并置空，下次 ensureClient/createSession
	 * 自行重建（session/create 原本就会 stop+重建，无新增副作用面）。
	 */
	async function cleanupEmptyDraft(sessionId) {
		try {
			await ctx.sessionAdmin.deleteSession({ sessionId, intent: "draftCleanup" });
			return true;
		} catch (error) {
			log(`清理被拒首发草稿失败（不掩盖原错）: ${error?.message ?? error}`);
			return false;
		}
	}

	// ── 方法处理器辅助 ──────────────────────────────────────────────────────────
	function requireSession() {
		if (!ctx.primarySession) {
			throw new BridgeError(-32002, "stepcode-bridge: no session; call session/create first");
		}
		return ctx.primarySession;
	}

	/**
	 * P0-04 收尾：显式模型选择落定（sendText 附带选择 / createSession firstInput 共用），
	 * 复用 switchModelConfig 已验证的 set_model 链路：失败如实抛错（不假装切换成功、
	 * 不继续发送）；成功后 get_state 回读权威值写入 primarySession.modelSelection——
	 * 快照只报实际生效模型，不回显请求值冒充。
	 */
	async function applyModelSelection(selection) {
		const session = requireSession();
		if (!selection.options && session.modelSelection?.providerId === selection.providerId && session.modelSelection?.modelId === selection.modelId && session.modelSelection.options) selection = { ...selection, options: session.modelSelection.options };
		try {
			return await ctx.runWithPreparedClient({ selection, requireIdle: true, selectModel: true }, async client => {
				const rpcState = await client.getState();
				if (typeof rpcState.model?.provider === "string" && typeof rpcState.model?.id === "string") session.modelSelection = { providerId: rpcState.model.provider, modelId: rpcState.model.id, ...(selection.options ? { options: selection.options } : {}) };
				if (rpcState.thinkingLevel) session.thoughtLevel = rpcState.thinkingLevel;
				ctx.persistConversation(); ctx.broadcastConversationSnapshot();
				return session.modelSelection;
			});
		} catch (error) {
			// 显式携带的模型选择是用户可见动作：CLI 失败必须如实报错（归类中文+原文），
			// 同 session/setModel / switchModelConfig 的语义。
			throw new BridgeError(-32000, classifyStepSendError(error, selection));
		}
	}

	/**
	 * 应用思考档位（session/setThoughtLevel 与 v4 switchModelConfig 共用）：
	 * 请求值必须是底座原生档位（get_available_thinking_levels）之一，否则如实拒绝；
	 * "default" 表示沿用模型默认——底座无"查询/重置默认档位"原语，此处不改动原生
	 * 档位（不猜一个值），快照 config.thought 持续反映 get_state 的实际生效值。
	 * 应用后以 get_state 回读为准（不回显请求值冒充已生效）。
	 */
	async function applyThoughtLevel(requested) {
		const session = requireSession();
		const normalized = typeof requested === "string" ? requested.trim().toLowerCase() : "";
		if (!normalized) return;
		return ctx.runWithPreparedClient({ requireIdle: true }, async client => {
		const levels = await client.getAvailableThinkingLevels();
		const level = ctx.resolveThoughtLevel(normalized, levels, (await client.getState()).thinkingLevel);
		if (level) await client.setThinkingLevel(level);
		const rpcState = await client.getState();
		if (typeof rpcState.thinkingLevel === "string" && rpcState.thinkingLevel) {
			session.thoughtLevel = rpcState.thinkingLevel;
		}
		session.thoughtLevels = levels;
		ctx.persistConversation();
		});
	}

	return { restoreSession, admitAndSend, cleanupEmptyDraft, requireSession, applyModelSelection, applyThoughtLevel };
}
