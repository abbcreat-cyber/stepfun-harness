/*
 * conversation-snapshot.mjs — v4 conversation snapshot 与四种行的构造工厂。
 *
 * 从 wire-shapes.mjs 拆出（消 1 个 max-lines error；公开出口仍是 wire-shapes.mjs
 * 的 re-export，包外导入不变）。字段形状对齐 stepcode-desktop/packages/shared 的
 * zod .strict() schema；tools/schema-probe.mjs 用仓库 schema 逐一验证样例。
 *
 * P0-02 新增可选参数：inputRouting / queue / followupMode；能力对齐轮（2026-10-05）
 * 再增 modelSelection/thoughtLevel（config 反映实际选型），availability 以
 * 队列与 compact 已接通；其余能力按实际处理器声明，防回退见 suites/capability-consistency.mjs。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 * Community-maintained adapter; not affiliated with or endorsed by Z.ai.
 */

/** v4 conversation snapshot 的 protocolVersion literal（rows/snapshot 协议自身版本 = 1）。 */
export const V4_SNAPSHOT_PROTOCOL_VERSION = 1;

/** 用户可见的社区后端名（中性命名，不冒充官方）。 */
export const COMMUNITY_BACKEND_LABEL = "Step Code";

/**
 * v4 conversation snapshot 的空态/当前态（conversationSnapshotSchema）。
 * queue/inputRouting 由桥接的 InputLedger 提供（P0-02）；缺省保持空态。
 */
export function makeConversationSnapshot({
	sessionId,
	logEpoch,
	seq,
	revision,
	rows = [],
	phase = "draft",
	pendingInteractions = [],
	workflowRuns,
	backgroundWorks = [],
	usage,
	mode = "build",
	inputRouting,
	queue,
	followupMode = "queue",
	modelSelection,
	thoughtLevel,
	readOnly = false,
}) {
	const running = !readOnly && (phase === "running" || phase === "prewarming");
	return {
		protocolVersion: V4_SNAPSHOT_PROTOCOL_VERSION,
		sessionId,
		logEpoch,
		seq,
		revision,
		control: {
			phase,
			sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error",
			canStop: running,
			stopState: running ? "stoppable" : "idle",
			stopTargetKind: "unknown",
			activeWorks: [],
			lastError: null,
			apiRetry: null,
		},
		availability: {
			// 能力声明必须对应实际处理器；压缩契约见 docs/specs/manual-compaction.md。
			// allowed=true 的键必须有 bin/zcode-bridge-session.mjs 的 v4/command 处理分支
			// （suites/capability-consistency.mjs 静态断言防回退）。行级 canFork 来自原生稳定锚点。
			fork: { allowed: !readOnly && !running, ...(readOnly || running ? { reasonCode: "guard.sessionBusy" } : {}) },
			compact: { allowed: true },
			// switchModelConfig/setFollowupMode 有真实处理器（模型经 set_model、
			// 档位经 set_thinking_level、跟进模式进 primarySession.followupMode）。
			switchModelConfig: { allowed: true },
			setFollowupMode: { allowed: true },
			queueEdit: { allowed: true },
			sendQueuedNow: { allowed: true },
			pauseGoal: { allowed: false, reasonCode: "stepcode.community.noGoal" },
			resumeGoal: { allowed: false, reasonCode: "stepcode.community.noGoal" },
		},
		inputRouting: inputRouting ?? { mode: "startNow" },
		config: {
			...(modelSelection ? { modelSelection } : {}),
			// config 反映会话实际选型（P0-04：切换后快照不得停留在静态默认值）。
			provider: modelSelection?.providerId ?? "step",
			model: modelSelection?.modelId ?? "step-5-preview",
			thought: thoughtLevel ?? "default",
			followupMode,
			mode,
		},
		usage: usage ?? {
			contextWindow: { usedTokens: 0, maxTokens: 0, autoCompactThresholdTokens: 0 },
			cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		},
		queue: queue ?? { items: [], autoDrain: false },
		pendingInteractions,
		...(workflowRuns ? { workflowRuns } : {}),
		pendingCommands: [],
		backgroundWorks,
		goal: null,
		plan: { items: [], updatedAt: Date.now() },
		rows: {
			window: readOnly || running ? rows.map(row => {
				if (!row.actions?.canFork) return row;
				// 动作 schema 只接受 true 或缺省；不能用 false 使整份投影被前端拒收。
				const actions = { ...row.actions }; delete actions.canFork;
				return { ...row, actions };
			}) : rows,
			totalCount: rows.length,
			// firstRowId 是 rowsWindowSchema 必填可空字段（shared/src/zcode-protocol-v4/
			// snapshot.ts:457 z.number().nullable()）：空窗口必须显式发 null——省略字段会被
			// 壳侧 frameSchema 拒收并终态成 fault.subscription.contentRejected（新会话
			// draft/prewarming 初始帧即空 rows，正是该故障的触发面）。
			firstRowId: rows.length > 0 ? rows[0].rowId : null,
		},
	};
}

/**
 * v4 conversation 行（conversationRowSchema discriminatedUnion "kind"）。
 * 本适配层投影四种：turnHeader / userInput / assistantText / toolCall。
 * state/origin/status 的合法值见 shared/src/zcode-protocol-v4/rows.ts。
 */
export function makeTurnHeaderRow({ rowId, turnId, state = "completedSuccess" }) {
	return {
		rowId,
		turnId,
		createdAt: Date.now(),
		createdAtSeq: rowId,
		kind: "turnHeader",
		origin: "userInput",
		state,
		startedAt: Date.now(),
	};
}

export function makeUserInputRow({ rowId, turnId, text, attachments = [] }) {
	return {
		rowId,
		turnId,
		createdAt: Date.now(),
		createdAtSeq: rowId,
		kind: "userInput",
		text,
		origin: "realUser",
		...(attachments.length ? { attachments } : {}),
	};
}

export function makeAssistantTextRow({ rowId, turnId, text, state = "complete" }) {
	return {
		rowId,
		turnId,
		createdAt: Date.now(),
		createdAtSeq: rowId,
		kind: "assistantText",
		text,
		state,
	};
}

export function makeToolCallRow({ rowId, turnId, toolCallId, toolName, inputText, status = "success" }) {
	return {
		rowId,
		turnId,
		createdAt: Date.now(),
		createdAtSeq: rowId,
		kind: "toolCall",
		toolCallId,
		toolName,
		status,
		inputText,
	};
}
