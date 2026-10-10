/*
 * input-admission.mjs — 输入准入路由（纯函数）与台账（InputLedger）。
 *
 * P0-01/P0-02 的实现收口（docs/step-input-admission-queue-spec.md）：
 * - decideAdmission：idle→prompt；busy 按 requestedDelivery/followupMode 三分流
 *   （followUp 排队 / steer 降级近似 / guide 拒绝）。
 * - InputLedger：按 commandId 记账（queueItemId=qi_<commandId>、admissionSeq 递增），
 *   失败 markFailed 回滚（失败项退出队列投影与归属候选），agent_start 归属用
 *   「最近 submitted 优先，否则 followUp 池中仍在的最老 queued」。
 * - queueItems 只铸 queueItemSchema 内字段（input-intent.ts .strict()），内部状态
 *   留在台账对象上，防快照 .strict() 炸帧。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 * Community-maintained adapter; not affiliated with or endorsed by Z.ai.
 */

/**
 * 忙碌排队的显式模型选择降级码（spec §9）：带显式模型选择的输入在忙碌时入队，
 * 模型意图只记录在 queueItem.modelSelection / ACK，不切进程模型——执行时用的是
 * 当时进程模型，可能不按所选模型。机器可辨，不假装会按所选模型执行。
 */
export const MODEL_DEFERRED_REASON_CODE = "stepcode.community.modelDeferred";

/**
 * 输入是否可发送（对齐底座 session-flow 的真实定义）：有非空文本或有附件即可。
 * 纯图片（空文本+附件）合法；纯空白（无文字无附件）拒绝。
 * @param {{ text?: string, attachments?: unknown[] } | null | undefined} input
 * @returns {boolean}
 */
export function hasPromptInput(input) {
	if (!input || typeof input !== "object") return false;
	const text = typeof input.text === "string" ? input.text : "";
	if (text.trim().length > 0) return true;
	return Array.isArray(input.attachments) && input.attachments.length > 0;
}

/**
 * 准入路由纯函数（spec §1 裁决表）。
 * @param {{ busy?: boolean, requestedDelivery?: string, followupMode?: string }} input
 * @returns {{ route: "prompt"|"followUp"|"steer"|"reject", delivery: "startNow"|"queue", fallbackReasonCode?: string, reasonCode?: string }}
 */
export function decideAdmission({ busy = false, requestedDelivery, followupMode = "queue" } = {}) {
	if (!busy) return { route: "prompt", delivery: "startNow" };
	if (requestedDelivery === "startNow") {
		// 官方 startNow 是 CLI 原子抢占；桥接无此原语，用原生 steer 近似（spec §1.1）。
		// ACK delivery 枚举只有 startNow|queue|guide，取 queue 为最不坏近似。
		return { route: "steer", delivery: "queue", fallbackReasonCode: "stepcode.community.noAtomicPreempt" };
	}
	if (requestedDelivery === "guide" || (!requestedDelivery && followupMode === "guide")) {
		return { route: "reject", delivery: "queue", reasonCode: "stepcode.community.guideNotWired" };
	}
	return { route: "followUp", delivery: "queue" };
}

/**
 * 把宿主提交的模型选择净化为 modelSelectionSchema 形状（strict，防带杂字段入 queueItem）。
 * @param {any} selection
 * @returns {{ providerId: string, modelId: string } | undefined}
 */
export function sanitizeModelSelection(selection) {
	if (!selection || typeof selection !== "object") return undefined;
	if (typeof selection.providerId !== "string" || typeof selection.modelId !== "string") return undefined;
	// 队列撤回会把选择原样写回 composer；丢掉 reasoningLevel 会触发提交门禁永久灰掉。
	const reasoningLevel = selection.options?.reasoningLevel;
	return { providerId: selection.providerId, modelId: selection.modelId,
		...(typeof reasoningLevel === "string" && reasoningLevel.trim() ? { options: { reasoningLevel: reasoningLevel.trim() } } : {}),
	};
}

/**
 * 准入台账：session worker 独占持有。内部状态机：
 * pending（begin，调用在途）→ submitted（prompt 成功）/ queued（followUp 成功）/
 * steered（steer 成功）→ attributed（agent_start 归属消费）；markFailed 任意态可进
 * failed（退出队列投影与归属候选）。
 */
export class InputLedger {
	constructor() {
		/** @type {Map<string, any>} */
		this.entries = new Map();
		this.admissionSeq = 0;
		/** 最近一次 queue_update 的原生池快照（文本数组）。 */
		this.nativeQueue = { steering: [], followUp: [] };
		/** stop 冻结：保留队列项展示，不再 reconcile。 */
		this.frozen = false;
		this.pauseReason = null;
	}

	/**
	 * 登记一条准入（必须先于 client.prompt/steer/followUp 调用，agent_start 投影才能归属）。
	 * @param {{ commandId: string, kind?: string, text: string, attachments?: any[], requestedDelivery?: string, followupMode?: string, busy?: boolean, clientId?: string, mode?: string, modelSelection?: any, modelSelectionExplicit?: boolean }} input
	 */
	begin(input) {
		const commandId = input.commandId;
		this.admissionSeq += 1;
		const decision = decideAdmission(input);
		// 模型降级内部标记（spec §9）：显式携带且有效的模型选择在忙碌时入队
		// （followUp/steer，未先落定）——执行时可能不按该模型。内部状态留在台账，
		// 对外投影为机器可辨标记：followUp 项占 delivery.fallbackReasonCode；
		// steer 项 delivery 槽保持 noAtomicPreempt（UI steer 识别依赖），模型降级
		// 挂 steer.reasonCode（同为已声明字段，快照链路 parse 存活——ACK 的 additive
		// 字段已声明、经宿主 parse 存活，快照与 ACK 构成双通道）。
		const modelDeferred = input.modelSelectionExplicit === true
			&& input.modelSelection !== undefined
			&& (decision.route === "followUp" || decision.route === "steer");
		const entry = {
			commandId,
			queueItemId: `qi_${commandId}`,
			admissionSeq: this.admissionSeq,
			kind: input.kind ?? "sendText",
			text: input.text,
			attachments: Array.isArray(input.attachments) ? input.attachments : [],
			clientId: input.clientId ?? "stepcode-bridge",
			mode: input.mode,
			automationId: input.automationId,
			toolDisallowlist: input.toolDisallowlist,
			botDeliveryTarget: input.botDeliveryTarget,
			workflowNotice: input.workflowNotice,
			modelSelection: input.modelSelection,
			requestedDelivery: input.requestedDelivery,
			decision,
			modelDeferred,
			state: "pending",
			admittedAt: Date.now(),
		};
		this.entries.set(commandId, entry);
		return entry;
	}

	/** @param {string} commandId */
	markSubmitted(commandId) {
		const entry = this.entries.get(commandId);
		if (entry && entry.state === "pending") entry.state = "submitted";
	}

	/** @param {string} commandId */
	markQueued(commandId) {
		const entry = this.entries.get(commandId);
		if (entry && entry.state === "pending") entry.state = "queued";
	}

	/** 桥接拥有尚未交给底座的队列；原生 queue_update 不得消费它。 */
	managedQueued() {
		return [...this.entries.values()].filter(e => e.managed && e.state === "queued")
			.sort((a, b) => (a.queuePosition ?? a.admissionSeq) - (b.queuePosition ?? b.admissionSeq));
	}

	serializeQueue() {
		return [...this.entries.values()].filter(e => e.managed && ["queued", "submitted", "pending"].includes(e.state));
	}

	restoreQueue(entries = []) {
		this.reset();
		for (const saved of entries) {
			if (!saved.managed || saved.state !== "queued") continue;
			this.entries.set(saved.commandId, { ...saved });
			this.admissionSeq = Math.max(this.admissionSeq, saved.admissionSeq);
		}
		// 恢复只重放明确未投递的消息，并等待用户点击继续，避免重启后意外执行。
		if (this.entries.size) this.holdAll("manual");
	}

	resume() { this.frozen = false; this.pauseReason = null; }

	/** @param {string} commandId */
	markSteered(commandId) {
		const entry = this.entries.get(commandId);
		if (entry && entry.state === "pending") entry.state = "steered";
	}

	/**
	 * 失败回滚：失败项从队列投影与归属候选中排除（防 agent_start 迟到误归属、
	 * 防下次 drain 错归属到已失败命令）。
	 * @param {string} commandId
	 */
	markFailed(commandId) {
		const entry = this.entries.get(commandId);
		if (entry) entry.state = "failed";
	}

	/** @param {string} commandId */
	isSubmitted(commandId) {
		const entry = this.entries.get(commandId);
		return entry?.state === "pending" || entry?.state === "submitted";
	}

	/**
	 * agent_start 归属（spec §3.4）：最近 submitted/pending 优先（rpc-client 的响应
	 * resolve 走微任务，agent_start 事件可能先于 markSubmitted 到达，pending 也算
	 * 在途直发）；否则 followUp 池中仍在的最老 queued。命中转 attributed（退出队列
	 * 投影）。工作流通知直发 prompt 不进台账，不会被误归属。
	 * @param {{ steering: string[], followUp: string[] }} [nativeQueue] 显式池快照；缺省用最近 queue_update。
	 * @returns {any | null}
	 */
	attributeNextRun(nativeQueue = this.nativeQueue) {
		// 追加 ACK 可先于新轮 agent_start；已接受的 steer 也能成为实际新轮输入。
		const candidates = [...this.entries.values()].filter((e) => e.state === "pending" || e.state === "submitted" || e.state === "steered");
		if (candidates.length > 0) {
			const entry = candidates.reduce((a, b) => (a.admissionSeq >= b.admissionSeq ? a : b));
			entry.state = "attributed";
			return entry;
		}
		const pool = Array.isArray(nativeQueue?.followUp) ? nativeQueue.followUp : [];
		const queued = [...this.entries.values()]
			.filter((e) => e.state === "queued" && pool.includes(e.text))
			.sort((a, b) => a.admissionSeq - b.admissionSeq);
		if (queued.length > 0) {
			queued[0].state = "attributed";
			return queued[0];
		}
		return null;
	}

	/**
	 * 记录 queue_update 池快照并 reconcile：已不在 followUp 池中的 queued 项视为被
	 * 底座消费，清出队列投影。冻结（stop）后不 reconcile（spec §4）。
	 * @param {{ steering?: string[], followUp?: string[] }} update
	 */
	applyNativeQueue(update) {
		this.nativeQueue = {
			steering: Array.isArray(update?.steering) ? [...update.steering] : [],
			followUp: Array.isArray(update?.followUp) ? [...update.followUp] : [],
		};
		if (this.frozen) return;
		for (const entry of this.entries.values()) {
			if (!entry.managed && entry.state === "queued" && !this.nativeQueue.followUp.includes(entry.text)) {
				entry.state = "attributed";
			}
		}
	}

	/**
	 * stop 冻结：快照保留队列项 + autoDrain=false + pauseReason；两条 stop 路径在
	 * abort 前调用。
	 * @param {"stopped"|"manual"|"error"} reason
	 */
	holdAll(reason) {
		this.frozen = true;
		this.pauseReason = reason;
	}

	/** 新会话/恢复会话时整体清零。 */
	reset() {
		this.entries.clear();
		this.admissionSeq = 0;
		this.nativeQueue = { steering: [], followUp: [] };
		this.frozen = false;
		this.pauseReason = null;
	}

	/**
	 * 队列投影：铸 queueItemSchema（input-intent.ts .strict()）内的字段，禁止附加
	 * 便利字段。steered 项保留展示（近似记录），agent_settled 时由 settleTurn 清理。
	 * @returns {any[]}
	 */
	queueItems() {
		return [...this.entries.values()]
			.filter((entry) => entry.state === "queued" || entry.state === "steered" || (entry.managed && entry.state === "submitted"))
			.sort((a, b) => (a.queuePosition ?? a.admissionSeq) - (b.queuePosition ?? b.admissionSeq))
			.map((entry) => {
				const delivery = {
					requested: entry.requestedDelivery === "startNow" || entry.requestedDelivery === "queue" || entry.requestedDelivery === "guide" ? entry.requestedDelivery : "auto",
					admitted: "queue",
				};
				if (entry.decision.fallbackReasonCode) delivery.fallbackReasonCode = entry.decision.fallbackReasonCode;
				// 模型降级（spec §9）：followUp 项槽位空闲时占 delivery 槽。
				else if (entry.modelDeferred) delivery.fallbackReasonCode = MODEL_DEFERRED_REASON_CODE;
				const steerReason = entry.modelDeferred ? MODEL_DEFERRED_REASON_CODE : entry.decision.fallbackReasonCode;
				const steer = entry.state === "steered"
					? {
						state: "steering",
						// steer+显式模型：delivery 槽保持 noAtomicPreempt（UI 的 steer 近似
						// 识别只认该码，stepQueueExperience isStepQueueItemSteerApproximation），
						// 模型降级挂 steer.reasonCode——已声明字段，快照链路 parse 存活
						// （ACK 侧 additive 字段经宿主 parse 被 strip，spec §9 注记）。
						...(steerReason ? { reasonCode: steerReason } : {}),
					}
					: { state: "notRequested" };
				return {
					sourceCommandId: entry.commandId,
					queueItemId: entry.queueItemId,
					clientId: entry.clientId,
					kind: entry.kind,
					text: entry.text,
					attachments: entry.attachments.map((a) => ({ ref: a.ref, fileName: a.fileName, mime: a.mime, bytes: a.bytes })),
					...(entry.mode !== undefined ? { mode: entry.mode } : {}),
					...(entry.modelSelection !== undefined ? { modelSelection: entry.modelSelection } : {}),
					delivery,
					order: { admissionSeq: entry.admissionSeq, queuePosition: entry.queuePosition ?? entry.admissionSeq },
					steer,
					dispatch: { state: entry.state === "submitted" ? "reserved" : "queued" },
					admittedAt: entry.admittedAt,
					provenance: { sourceCommandId: entry.commandId, queueItemId: entry.queueItemId, clientId: entry.clientId },
				};
			});
	}

	/** turn 终态：清当前已归属项与被并入的 steered 项（近似记录随 turn 结束退场）。 */
	settleTurn() {
		for (const entry of this.entries.values()) {
			if (entry.state === "steered") entry.state = "attributed";
		}
	}

	/**
	 * 快照 inputRouting（snapshot.ts inputRoutingSchema）。
	 * @param {{ busy?: boolean, followupMode?: string }} input
	 */
	inputRouting({ busy = false, followupMode = "queue" } = {}) {
		if (!busy) return { mode: "startNow" };
		if (followupMode === "guide") return { mode: "guide", reasonCode: "stepcode.community.guideNotWired" };
		return { mode: "enqueue" };
	}

	/**
	 * 快照 queue 状态（queueStateSchema）。
	 * @param {{ autoDrain?: boolean }} [options]
	 */
	queueState(options = {}) {
		const items = this.queueItems();
		const autoDrain = options.autoDrain ?? (!this.frozen && items.length > 0);
		const state = { items, autoDrain };
		if (this.pauseReason) state.pauseReason = this.pauseReason;
		return state;
	}
}
