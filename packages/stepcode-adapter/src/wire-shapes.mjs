import { workflowSlashCommands } from "./workflow/catalog.mjs";
import { InputLedger } from "./input-admission.mjs";
import {
	COMMUNITY_BACKEND_LABEL,
	V4_SNAPSHOT_PROTOCOL_VERSION,
	makeConversationSnapshot,
	makeTurnHeaderRow,
	makeUserInputRow,
	makeAssistantTextRow,
	makeToolCallRow,
} from "./conversation-snapshot.mjs";
/*
 * wire-shapes.mjs — ZCode Protocol（legacy session/* 与 v4 conversation 帧）
 * 响应与通知的构造工厂。字段形状对齐 stepcode-desktop/packages/shared 的
 * zod .strict() schema；tools/schema-probe.mjs 用仓库 schema 逐一验证本文件
 * 产出的样例（`npx tsx tools/schema-probe.mjs --validate`）。
 *
 * v4 conversation snapshot 与四种行构造器已拆至 ./conversation-snapshot.mjs
 * （P0-02：消 max-lines error），此处 re-export 保持同名导出——包外导入出口
 * （package.json ./wire-shapes 与 suites 的 import）不变。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 * Community-maintained adapter; not affiliated with or endorsed by Z.ai.
 */

export {
	V4_SNAPSHOT_PROTOCOL_VERSION,
	COMMUNITY_BACKEND_LABEL,
	makeConversationSnapshot,
	makeTurnHeaderRow,
	makeUserInputRow,
	makeAssistantTextRow,
	makeToolCallRow,
} from "./conversation-snapshot.mjs";

/** snapshot.protocol 的两个 literal（zcode-protocol/index.ts ZCODE_PROTOCOL_*）。 */
export const PROTOCOL_NAME = "ZCode Protocol";
export const PROTOCOL_VERSION = 1;

/**
 * v4 topic 物理帧外层信封的 wireVersion literal
 * （对齐 stepcode-desktop/packages/shared zcode-protocol-v4/core.ts 的 V4_WIRE_PROTOCOL_VERSION = 3）。
 * Host 在路由边界先用 topicWireFrameCandidateSchema（discriminatedUnion("kind"): complete|fragment）
 * 校验信封，再由 assembler 校验内层 frame；裸发内层帧会被整条丢弃（app.log 会打
 * "丢弃无效 v4 conversation frame: Expected 'complete' | 'fragment'"）。
 */
export const V4_WIRE_PROTOCOL_VERSION = 3;

/**
 * topic 逻辑帧序号与 deliveryKind 状态（进程内单例；bridge 是唯一消费者）。
 * - logicalFrameOrdinal：按 topic 单调递增的正整数（1 起）。
 * - deliveryKind：每个 (topic, subscriptionId) 的首帧 = "initial"（订阅后第一帧），
 *   其后在线更新为 "online"，resync 显式指定 "recovery"。
 */
const wireFrameOrdinals = new Map();
const wireFrameInitialSent = new Set();

function wrapTopicWireFrame(topic, subscriptionId, innerFrame, requestedDeliveryKind) {
	const ordinal = (wireFrameOrdinals.get(topic) ?? 0) + 1;
	wireFrameOrdinals.set(topic, ordinal);
	const initialKey = `${topic}#${subscriptionId}`;
	// 恢复帧必须显式标记，否则 Renderer 不会结束 recovery 等待。
	const deliveryKind = requestedDeliveryKind ?? (wireFrameInitialSent.has(initialKey) ? "online" : "initial");
	wireFrameInitialSent.add(initialKey);
	// 内层 frame 保持原子（bridge 不做 UTF-8 层分片），因此外层恒为 kind="complete"。
	return {
		wireVersion: V4_WIRE_PROTOCOL_VERSION,
		kind: "complete",
		deliveryKind,
		logicalFrameId: `lf_${topic}_${ordinal}`,
		logicalFrameOrdinal: ordinal,
		topic,
		subscriptionId,
		frame: innerFrame,
	};
}

/** Step-Code 侧默认模型选择（session/create 的 params.model 缺省时的回退）。 */
export function defaultModelSelection() {
	return { providerId: "step", modelId: "step-5-preview" };
}

let idCounter = 0;
/** 进程内唯一 id（bridge 每请求/事件/行生成；无需跨进程持久唯一）。 */
export function nextId(prefix) {
	idCounter += 1;
	return `${prefix}_${Date.now().toString(36)}_${process.pid}_${idCounter}`;
}

/**
 * session/create 等 result 的 snapshot（zcodeSessionStateSnapshotSchema）。
 * messages 恒空数组：历史消息投影走 v4 conversation 帧，不走 snapshot。
 * thoughtLevels：{ available: string[], current?: string }——桥接从底座
 * get_available_thinking_level 读到的真实档位面（有则 enabled=true；缺省保持
 * enabled=false，即"该会话未暴露档位面"，不冒充支持）。
 */
export function makeSessionStateSnapshot({ sessionId, workspace, modelSelection, title, mode = "build", thoughtLevels }) {
	const now = Date.now();
	return {
		protocol: { name: PROTOCOL_NAME, version: PROTOCOL_VERSION },
		session: {
			sessionId,
			workspace: {
				workspacePath: workspace.workspacePath,
				workspaceKey: workspace.workspaceKey ?? workspace.workspacePath,
				...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
				...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
			},
			sessionKind: "interactive",
			title: title ?? `${COMMUNITY_BACKEND_LABEL} session`,
			mode,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		},
		settings: {
			model: {
				current: modelSelection ?? defaultModelSelection(),
				available: [],
			},
			thoughtLevel: Array.isArray(thoughtLevels?.available) && thoughtLevels.available.length > 0
				? {
					enabled: true,
					...(typeof thoughtLevels.current === "string" && thoughtLevels.current ? { current: thoughtLevels.current } : {}),
					available: thoughtLevels.available.map((level) => ({ value: level, label: level })),
				}
				: { enabled: false, available: [] },
			mode: { current: mode },
		},
		projection: {
			sessionId,
			status: "idle",
			mode,
			turnCount: 0,
			totalTokenCount: 0,
			contextUsed: 0,
			contextWindow: 0,
			pendingPermissions: [],
			activeToolCalls: [],
			backgroundJobs: [],
		},
		runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
		messages: [],
	};
}

/** session/event 通知的 params（zcodeSessionEventSchema：envelope + type + payload）。 */
export function makeSessionEvent({ type, sessionId, seq, turnId, payload }) {
	const event = {
		eventId: nextId("evt"),
		sessionId,
		seq,
		timestamp: Date.now(),
		type,
	};
	if (turnId !== undefined) event.turnId = turnId;
	if (payload !== undefined) event.payload = payload;
	return event;
}

/** state.updated 通知的 params。 */
export function makeStateUpdated({ sessionId, revision, scope = "session" }) {
	return { type: "state.updated", scope, sessionId, revision, patch: {} };
}

/** v4 subscribe ACK（conversation 可带 openTiming；sessions-index/workspace-config 不带）。 */
export function makeSubscribeAck({ subscriptionId, logEpoch, openTiming }) {
	const ack = { subscriptionId, mode: "snapshot", logEpoch };
	if (openTiming !== undefined) ack.openTiming = openTiming;
	return ack;
}


/** v4/command 响应信封（commandAckSchema）：accepted + 可选 result。 */
export function makeCommandAck({ commandId, revisionAtDecision, result }) {
	const ack = { commandId, status: "accepted", revisionAtDecision };
	if (result !== undefined) ack.result = result;
	return ack;
}

/**
 * sessions-index 的单条 SessionSummary（snapshot 与 session.upserted delta 共用；
 * 字段形状对齐 sessionSummarySchema：sessionId/workspaceId/title/phase/sessionEnded/
 * hasBackgroundWork/lastActivityAt/createdAt）。
 */
export function makeSessionSummary({
	sessionId,
	workspaceId,
	title,
	phase,
	sessionEnded,
	hasBackgroundWork,
	pendingInteractionSummary,
	lastActivityAt,
	createdAt,
}) {
	return {
		sessionId,
		workspaceId,
		title: title ?? `${COMMUNITY_BACKEND_LABEL} session`,
		phase: phase ?? "completedSuccess",
		sessionEnded: sessionEnded ?? true,
		hasBackgroundWork: hasBackgroundWork ?? false,
		...(pendingInteractionSummary ? { pendingInteractionSummary } : {}),
		lastActivityAt: lastActivityAt ?? Date.now(),
		createdAt: createdAt ?? Date.now(),
	};
}

/** sessions-index topic 的初始 snapshot（sessionsIndexSnapshotSchema）。 */
export function makeSessionsIndexSnapshot({ workspaceId, logEpoch, sessions }) {
	return {
		protocolVersion: V4_SNAPSHOT_PROTOCOL_VERSION,
		workspaceId,
		logEpoch,
		sessions: sessions.map((session) =>
			makeSessionSummary({ ...session, workspaceId }),
		),
	};
}

/** workspace-config topic 的初始 snapshot（workspaceConfigSnapshotSchema，空目录）。 */
export function makeWorkspaceConfigSnapshot({ workspaceId, logEpoch }) {
	return {
		protocolVersion: V4_SNAPSHOT_PROTOCOL_VERSION,
		workspaceId,
		logEpoch,
		config: { configOptions: [], slashCommands: workflowSlashCommands },
	};
}

/** v4/conversation/frame 通知的 params（外层 complete 信封 + 内层 snapshot 帧）。 */
export function makeConversationSnapshotFrame({ topic, subscriptionId, toSeq, snapshot, deliveryKind }) {
	return wrapTopicWireFrame(topic, subscriptionId, {
		topic,
		subscriptionId,
		fromSeq: 0,
		toSeq,
		sentAt: Date.now(),
		payload: { kind: "snapshot", snapshot },
	}, deliveryKind);
}

/** v4/conversation/frame 通知的 params（外层 complete 信封 + 内层 deltas 帧）。 */
export function makeConversationDeltasFrame({ topic, subscriptionId, fromSeq, toSeq, deltas }) {
	return wrapTopicWireFrame(topic, subscriptionId, {
		topic,
		subscriptionId,
		fromSeq,
		toSeq,
		sentAt: Date.now(),
		payload: { kind: "deltas", deltas },
	});
}

/**
 * 探针样例集（tools/schema-probe.mjs --validate 消费；schema 配对在该探针里维护，
 * 因为 .mjs 不能 import 仓库 TS schema）。
 */

/** 用 InputLedger 铸造一个排队项（与线上 queueItems 同一代码路径，供探针样例）。 */
function queueItemsForProbe() {
	const ledger = new InputLedger();
	ledger.begin({
		commandId: "cmd-queued",
		kind: "sendText",
		text: "排队样例",
		attachments: [{ ref: "step-attachment:probe", fileName: "probe.png", mime: "image/png", bytes: 96 }],
		requestedDelivery: "queue",
		followupMode: "queue",
		busy: true,
		clientId: "probe-client",
		mode: "build",
		modelSelection: { providerId: "step", modelId: "step-5-preview" },
	});
	ledger.markQueued("cmd-queued");
	return ledger.queueState({ autoDrain: true });
}

export function sampleWireObjects() {
	const sessionId = "probe-session-1";
	return {
		modelSelectionDefault: defaultModelSelection(),
		snapshot: makeSessionStateSnapshot({
			sessionId,
			workspace: { workspacePath: "C:/tmp/probe", workspaceKey: "C:/tmp/probe" },
		}),
		turnStartedEvent: makeSessionEvent({
			type: "turn.started",
			sessionId,
			seq: 1,
			payload: { turnNumber: 1, input: "hi" },
		}),
		partDeltaEvent: makeSessionEvent({
			type: "part.delta",
			sessionId,
			seq: 2,
			payload: { messageId: "m1", partId: "p1", field: "text", delta: "你好" },
		}),
		turnCompletedEvent: makeSessionEvent({
			type: "turn.completed",
			sessionId,
			seq: 3,
			payload: {
				response: "ok",
				tokenCount: 0,
				toolCallCount: 0,
				duration: 1,
				resultType: "success",
			},
		}),
		stateUpdated: makeStateUpdated({ sessionId, revision: 1 }),
		subscribeAck: makeSubscribeAck({ subscriptionId: "sub1", logEpoch: "epoch1" }),
		// 外层信封样例（makeConversationSnapshotFrame 现在直接产出 wire 信封 + 内层 frame）。
		conversationSnapshotWireFrame: makeConversationSnapshotFrame({
			topic: `conversation/${sessionId}`,
			subscriptionId: "sub1",
			toSeq: 1,
			snapshot: makeConversationSnapshot({
				sessionId,
				logEpoch: "epoch1",
				seq: 1,
				revision: 1,
				rows: [
					makeTurnHeaderRow({ rowId: 1, turnId: "t1" }),
					makeUserInputRow({ rowId: 2, turnId: "t1", text: "hi" }),
					makeAssistantTextRow({ rowId: 3, turnId: "t1", text: "hello" }),
					makeToolCallRow({
						rowId: 4,
						turnId: "t1",
						toolCallId: "tc1",
						toolName: "bash",
						inputText: "echo hi",
					}),
				],
			}),
		}),
		// 内层 frame 样例（从 wire 信封里取出 frame 字段，供 conversationTopicFrameSchema 校验）。
		conversationSnapshotFrame: makeConversationSnapshotFrame({
			topic: `conversation/${sessionId}`,
			subscriptionId: "sub1",
			toSeq: 1,
			snapshot: makeConversationSnapshot({
				sessionId,
				logEpoch: "epoch1",
				seq: 1,
				revision: 1,
				rows: [
					makeTurnHeaderRow({ rowId: 1, turnId: "t1" }),
					makeUserInputRow({ rowId: 2, turnId: "t1", text: "hi" }),
					makeAssistantTextRow({ rowId: 3, turnId: "t1", text: "hello" }),
					makeToolCallRow({
						rowId: 4,
						turnId: "t1",
						toolCallId: "tc1",
						toolName: "bash",
						inputText: "echo hi",
					}),
				],
			}),
		}).frame,
		conversationSnapshotWireCandidate: makeConversationSnapshotFrame({
			topic: `conversation/${sessionId}`,
			subscriptionId: "sub1",
			toSeq: 2,
			snapshot: makeConversationSnapshot({ sessionId, logEpoch: "epoch1", seq: 2, revision: 2 }),
		}),
		// 空 rows 回归样例（fault.subscription.contentRejected 根因护栏）：draft/prewarming 是
		// schema 注释（shared/src/zcode-protocol-v4/snapshot.ts:29-30）明确的"无 row"合法态，
		// 空窗口时 firstRowId 必须显式为 null 而不是省略字段——下方两条直接打内层帧 schema
		// （conversationTopicFrameSchema 内嵌 conversationSnapshotSchema；此前唯一的空 rows 样例
		// conversationSnapshotWireCandidate 只过信封 schema，信封对 frame 是 z.unknown().optional()，
		// 内层字段缺失漏网，正是线上 contentRejected 的漏测原因）。
		conversationSnapshotFrameEmptyRows: makeConversationSnapshotFrame({
			topic: `conversation/${sessionId}`,
			subscriptionId: "sub1",
			toSeq: 1,
			snapshot: makeConversationSnapshot({ sessionId, logEpoch: "epoch1", seq: 1, revision: 1, rows: [], phase: "draft" }),
		}).frame,
		conversationSnapshotFramePrewarmingEmpty: makeConversationSnapshotFrame({
			topic: `conversation/${sessionId}`,
			subscriptionId: "sub1",
			toSeq: 1,
			snapshot: makeConversationSnapshot({ sessionId, logEpoch: "epoch1", seq: 1, revision: 1, rows: [], phase: "prewarming" }),
		}).frame,
		// P0-02：带 queue.items / inputRouting / followupMode 的快照样例（busy 排队态）。
		// queueItem 从 InputLedger 铸造（与线上同一代码路径），schema-probe 配对
		// conversationTopicFrameSchema——queueItemSchema .strict() 防炸帧的探针防线。
		conversationSnapshotFrameWithQueue: makeConversationSnapshotFrame({
			topic: `conversation/${sessionId}`,
			subscriptionId: "sub1",
			toSeq: 3,
			snapshot: makeConversationSnapshot({
				sessionId,
				logEpoch: "epoch1",
				seq: 3,
				revision: 3,
				rows: [],
				phase: "running",
				inputRouting: { mode: "enqueue" },
				followupMode: "queue",
				queue: queueItemsForProbe(),
			}),
		}).frame,
		commandResultInputAcceptedQueue: {
			type: "inputAccepted",
			delivery: "queue",
			inputId: "input3",
		},
		accountConfigResult: { receivedRevision: "rev1", providerCount: 0, status: "received" },
		sessionSendResult: { sessionId, accepted: true, stateRevision: 1 },
		sessionSubscribeResult: { sessionId, eventSeq: 0, events: [] },
		sessionListResult: { sessions: [] },
		commandResultCreateSession: {
			type: "createSession",
			sessionId,
			input: { delivery: "startNow", inputId: "input1" },
		},
		commandResultInputAccepted: {
			type: "inputAccepted",
			delivery: "startNow",
			inputId: "input2",
		},
		commandAckSendText: makeCommandAck({
			commandId: "cmd-1",
			revisionAtDecision: 1,
			result: { type: "inputAccepted", delivery: "startNow", inputId: "input2" },
		}),
		commandAckStopNoResult: makeCommandAck({ commandId: "cmd-2", revisionAtDecision: 2 }),
		sessionsIndexSnapshotFrame: makeConversationSnapshotFrame({
			topic: "sessions-index/ws1",
			subscriptionId: "sub2",
			toSeq: 1,
			snapshot: makeSessionsIndexSnapshot({
				workspaceId: "ws1",
				logEpoch: "epoch1",
				sessions: [{ sessionId, lastActivityAt: 1_700_000_000_000, createdAt: 1_700_000_000_000 }],
			}),
		}).frame,
		sessionsIndexSnapshotWireFrame: makeConversationSnapshotFrame({
			topic: "sessions-index/ws1",
			subscriptionId: "sub2",
			toSeq: 1,
			snapshot: makeSessionsIndexSnapshot({
				workspaceId: "ws1",
				logEpoch: "epoch1",
				sessions: [{ sessionId, lastActivityAt: 1_700_000_000_000, createdAt: 1_700_000_000_000 }],
			}),
		}),
		workspaceConfigSnapshotFrame: makeConversationSnapshotFrame({
			topic: "workspace-config/ws1",
			subscriptionId: "sub3",
			toSeq: 1,
			snapshot: makeWorkspaceConfigSnapshot({ workspaceId: "ws1", logEpoch: "epoch1" }),
		}).frame,
		workspaceConfigSnapshotWireFrame: makeConversationSnapshotFrame({
			topic: "workspace-config/ws1",
			subscriptionId: "sub3",
			toSeq: 1,
			snapshot: makeWorkspaceConfigSnapshot({ workspaceId: "ws1", logEpoch: "epoch1" }),
		}),
	};
}
