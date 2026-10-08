/**
 * queue-model-deferred 套件（R2 评审 medium ① + 状态文档 §三.7 / §四.5）。
 *
 * 验收点（docs/step-input-admission-queue-spec.md §9/§10）：
 * 1. 忙碌时排队的消息若带显式模型选择，queueItem 与 ACK 都带机器可辨的降级标记
 *    `stepcode.community.modelDeferred`——含义是「执行时可能不按该模型」（模型意图
 *    只记录，不切进程模型），不假装会按所选模型执行。
 * 2. 标记只在「显式携带 + 忙碌入队」出现：idle 直发（模型先落定再发送）、非显式
 *    （sendText 回填会话当前模型）都不标；steer 项 delivery 槽保持 noAtomicPreempt
 *    不被覆盖（模型降级以 ACK 为准）。
 * 3. 每次准入决策落一行 bridge 日志（branch=direct/queue/steer/reject + commandId +
 *    delivery + modelDeferred），R6 类场景可从 bridge stderr/日志文件取证分支。
 *
 * 底座真实模型的观测点：assistantText 行的 model 字段（message_start 的
 * message.model，发送时刻的进程模型）。全部走 helpers.launchBridge 的 argv 状态目录
 * 通道（spec §8），不依赖任何 STECODE_* 环境变量。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBridge } from "./helpers.mjs";
import { InputLedger, MODEL_DEFERRED_REASON_CODE } from "../src/input-admission.mjs";

const MOCK_MINI = { providerId: "mock", modelId: "mock-mini" };

function sendCommand(b, id, params) {
	b.send({ id, method: "v4/command", params });
	return b.waitFor((f) => f.id === id, { label: `v4/command ${params.commandId}` });
}

async function createAndSubscribe(b, sessionId, baseId) {
	sendCommand(b, baseId, { commandId: `create-${sessionId}`, sessionId, type: "createSession", payload: { workspaceId: "ws" } }).catch(() => {});
	await b.waitFor((f) => f.id === baseId, { label: `createSession ${sessionId}` });
	b.send({ id: baseId + 1, method: "v4/conversation/subscribe", params: { topic: `conversation/${sessionId}`, connectionId: `c-${sessionId}`, clientMode: "desktop-continuous" } });
	await b.waitFor((f) => f.id === baseId + 1, { label: `订阅 ${sessionId}` });
}

function snapshotWithQueue(b, sessionId, count) {
	return b.frames
		.filter((f) => f.params?.topic === `conversation/${sessionId}` && f.params.frame?.payload?.snapshot?.queue?.items.length === count)
		.at(-1)?.params.frame.payload.snapshot;
}

function snapshotRows(b, sessionId) {
	return b.frames
		.filter((f) => f.params?.topic === `conversation/${sessionId}` && f.params.frame?.payload?.snapshot?.rows)
		.at(-1)?.params.frame.payload.snapshot.rows?.window ?? [];
}

/** 等某文本的完整回复行（assistantText.model = 底座真实模型——执行时实际用的模型）。 */
function waitForAssistantReply(b, sessionId, text) {
	const match = (r) => r.kind === "assistantText" && r.state !== "streaming" && r.text?.includes(`mock reply to: ${text}`);
	return b.waitFor(
		(f) => f.params?.topic === `conversation/${sessionId}`
			&& (f.params.frame?.payload?.snapshot?.rows?.window ?? []).some(match),
		{ timeoutMs: 30000, label: `${sessionId} 的回复行（${text}）` },
	).then(() => snapshotRows(b, sessionId).find(match));
}

/** 桥进程 stderr 追加收集（helpers 返回的 stderr 是 return 时的死快照，故自行挂监听）。 */
function collectStderr(b) {
	let text = "";
	b.child.stderr.on("data", (chunk) => { text += chunk; });
	return {
		get text() { return text; },
		/** 轮询等待 stderr 出现包含 substring 的行（日志经管道异步到达）。 */
		waitForLine(substring, { timeoutMs = 10000 } = {}) {
			return new Promise((resolve, reject) => {
				const startedAt = Date.now();
				const timer = setInterval(() => {
					if (text.includes(substring)) { clearInterval(timer); resolve(substring); }
					else if (Date.now() - startedAt > timeoutMs) {
						clearInterval(timer);
						reject(new Error(`timeout waiting for stderr line: ${substring}; stderr=${text}`));
					}
				}, 25);
			});
		},
	};
}

// ── 台账级（纯函数投影，不起桥） ─────────────────────────────────────────────

test("modelDeferred：台账投影——显式模型+busy 入队标 modelDeferred，非显式/垃圾选择不标", () => {
	const ledger = new InputLedger();
	ledger.begin({ commandId: "md-1", text: "显式排队", modelSelection: MOCK_MINI, modelSelectionExplicit: true, busy: true, requestedDelivery: "queue" });
	ledger.markQueued("md-1");
	const [marked] = ledger.queueItems();
	assert.equal(marked.delivery.fallbackReasonCode, MODEL_DEFERRED_REASON_CODE, "显式模型+忙碌排队必须带 modelDeferred 降级标记");
	assert.equal(marked.modelSelection.modelId, "mock-mini");

	// 非显式：sendText 回填会话当前模型（modelSelection 有值但非用户显式携带）不标。
	ledger.begin({ commandId: "md-2", text: "非显式排队", modelSelection: { providerId: "step", modelId: "step-5-preview" }, busy: true, requestedDelivery: "queue" });
	ledger.markQueued("md-2");
	const implicit = ledger.queueItems().find((i) => i.queueItemId === "qi_md-2");
	assert.equal("fallbackReasonCode" in implicit.delivery, false, "非显式模型选择不得挂降级标记");

	// 显式但 sanitize 失败（垃圾形状）：无模型投影即无误导面，不标。
	ledger.begin({ commandId: "md-3", text: "垃圾排队", modelSelection: undefined, modelSelectionExplicit: true, busy: true, requestedDelivery: "queue" });
	ledger.markQueued("md-3");
	const garbage = ledger.queueItems().find((i) => i.queueItemId === "qi_md-3");
	assert.equal("fallbackReasonCode" in garbage.delivery, false, "无效模型选择（无 modelSelection 投影）不标");

	// idle 直发：模型先落定再发送，非降级，不标（submitted 项本就不进队列投影）。
	ledger.begin({ commandId: "md-4", text: "空闲直发", modelSelection: MOCK_MINI, modelSelectionExplicit: true, busy: false });
	ledger.markSubmitted("md-4");
	assert.equal(ledger.queueItems().some((i) => i.queueItemId === "qi_md-4"), false, "idle 直发不进队列投影、无降级标记（模型已先落定）");
});

test("modelDeferred：steer 项 delivery 槽保持 noAtomicPreempt，模型降级挂 steer.reasonCode", () => {
	const ledger = new InputLedger();
	// steer + 显式模型：投递级降级码不动（UI isStepQueueItemSteerApproximation 只认它），
	// 模型降级标记挂 steer.reasonCode（已声明字段，快照链路 parse 存活——ACK 的
	// additive 字段虽已在 shared schema 声明、经 parse 不再被 strip，但 UI 消费仍以
	// queueItem 投影为主通道，不能只依赖 ACK）。
	ledger.begin({ commandId: "md-st", text: "插话带模型", modelSelection: MOCK_MINI, modelSelectionExplicit: true, busy: true, requestedDelivery: "startNow" });
	ledger.markSteered("md-st");
	const [item] = ledger.queueItems();
	assert.equal(item.steer.state, "steering");
	assert.equal(item.delivery.fallbackReasonCode, "stepcode.community.noAtomicPreempt", "steer 项投递级降级码不得被覆盖（UI 识别依赖）");
	assert.equal(item.steer.reasonCode, MODEL_DEFERRED_REASON_CODE, "steer+显式模型的降级标记必须挂 steer.reasonCode（宿主/UI 可达通道）");

	// 对照：无显式模型的 steer 项，steer.reasonCode 仍镜像 noAtomicPreempt（现状不变）。
	ledger.begin({ commandId: "md-st2", text: "插话无模型", modelSelection: { providerId: "step", modelId: "step-5-preview" }, busy: true, requestedDelivery: "startNow" });
	ledger.markSteered("md-st2");
	const plain = ledger.queueItems().find((i) => i.queueItemId === "qi_md-st2");
	assert.equal(plain.delivery.fallbackReasonCode, "stepcode.community.noAtomicPreempt");
	assert.equal(plain.steer.reasonCode, "stepcode.community.noAtomicPreempt", "无显式模型的 steer 项 reasonCode 保持镜像（零回归）");
});

test("modelDeferred：queueItem 标记经 shared schema parse 存活；ACK additive 字段不炸宿主校验（评审 high 防回退）", async () => {
	// 评审实测：宿主消费链路 zcodeProtocolClient.resolveResponse 用 resultSchema.parse
	// 且 resolve parse 后的值——zod 非严格对象默认 strip 未知键：R3 评审 high 修复前
	// ACK 的 fallbackReasonCode 到不了宿主/UI。该字段现已在 shared schema 声明
	// （zcode-protocol-v4/command.ts inputAccepted 分支，防漂移见 packages/shared/
	// test/stepInputAcceptedAckPassthrough.test.ts），经 parse 不再被 strip；但 UI
	// 消费仍以 queueItem 已声明字段（delivery.fallbackReasonCode / steer.reasonCode）
	// 为主通道（spec §9 ①，ACK 是第二通道），本用例锁死它们经 parse 不丢。
	const ledger = new InputLedger();
	ledger.begin({ commandId: "pd-q", text: "排队带模型", modelSelection: MOCK_MINI, modelSelectionExplicit: true, busy: true, requestedDelivery: "queue" });
	ledger.markQueued("pd-q");
	ledger.begin({ commandId: "pd-s", text: "插话带模型", modelSelection: MOCK_MINI, modelSelectionExplicit: true, busy: true, requestedDelivery: "startNow" });
	ledger.markSteered("pd-s");
	const items = ledger.queueItems();
	// 上游公共入口指向 TS 源码；与 suites/input-admission-queue.mjs 同法注册仓库 TS loader。
	const { register } = await import("tsx/esm/api");
	register();
	const { conversationInputIntentSchema, commandAckSchema } = await import("@zcode/shared/zcode-protocol-v4");

	const parsedFollowUp = conversationInputIntentSchema.parse(items.find((i) => i.queueItemId === "qi_pd-q"));
	assert.equal(parsedFollowUp.delivery.fallbackReasonCode, MODEL_DEFERRED_REASON_CODE, "followUp 项 delivery 槽标记必须经 parse 存活（宿主/UI 可达）");

	const parsedSteer = conversationInputIntentSchema.parse(items.find((i) => i.queueItemId === "qi_pd-s"));
	assert.equal(parsedSteer.delivery.fallbackReasonCode, "stepcode.community.noAtomicPreempt");
	assert.equal(parsedSteer.steer.reasonCode, MODEL_DEFERRED_REASON_CODE, "steer 项模型降级必须经 steer.reasonCode parse 存活——queueItem 是 UI 主消费通道（ACK 为第二通道）");

	// 桥侧 ACK 的 additive 字段不会破坏宿主校验（非 strict 对象允许未知键通过 parse）；
	// 该字段已在 shared schema 声明（inputAccepted 分支），经宿主 parse 存活——但 UI
	// 消费仍以 queueItem 投影为主（spec §9 ①），ACK 是第二通道。
	const parsedAck = commandAckSchema.parse({
		commandId: "pd-q",
		status: "accepted",
		revisionAtDecision: 1,
		result: { type: "inputAccepted", delivery: "queue", inputId: "pd-q", fallbackReasonCode: MODEL_DEFERRED_REASON_CODE },
	});
	assert.equal(parsedAck.status, "accepted", "ACK 带 additive 字段必须仍可通过宿主 commandAckSchema 校验（不炸链路）");
});

// ── E2E（launchBridge 走 argv 状态目录通道，spec §8） ─────────────────────────

test("managed model：忙碌排队保留模型，执行时真实切换，ACK 与队列不标降级", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	const stderr = collectStderr(b);
	try {
		await createAndSubscribe(b, "md-busy", 1);
		const ackA = await sendCommand(b, 10, { commandId: "md-a", sessionId: "md-busy", type: "sendText", payload: { text: "A".repeat(400) } });
		assert.equal(ackA.result.result.delivery, "startNow");
		assert.equal("fallbackReasonCode" in ackA.result.result, false, "idle 直发（A 未显式选模型）ACK 不得带降级标记");
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "md-busy", { label: "A turn.started" });

		// B：忙碌时不切 A 的模型；轮到 B 才由桥接托管队列落定 mock-mini。
		const ackB = await sendCommand(b, 11, {
			commandId: "md-b",
			sessionId: "md-busy",
			type: "sendText",
			payload: { text: "排队B带模型", requestedDelivery: "queue", modelSelection: MOCK_MINI },
		});
		assert.equal(ackB.result.status, "accepted");
		assert.equal(ackB.result.result.delivery, "queue");
		assert.equal(ackB.result.result.fallbackReasonCode, undefined, "桥接托管队列在轮到发送时应用模型，无需降级标记");

		await b.waitFor(() => snapshotWithQueue(b, "md-busy", 1) !== undefined, { timeoutMs: 10000, label: "B 进队列快照" });
		const itemB = snapshotWithQueue(b, "md-busy", 1).queue.items[0];
		assert.equal(itemB.text, "排队B带模型");
		assert.equal(itemB.modelSelection.modelId, "mock-mini", "模型意图如实投影（请求值）");
		assert.equal(itemB.delivery.fallbackReasonCode, undefined, "托管队列按该项模型发送");

		// 语义实证：B 的实际回复模型是该项所选模型，不能只断言请求/快照。
		const replyB = await waitForAssistantReply(b, "md-busy", "排队B带模型");
		assert.equal(replyB.model, "mock-mini", "排队项实际执行时落定模型");

		// 准入决策日志（spec §10）：direct 与 queue 分支均可从 stderr/bridge 日志取证。
		await stderr.waitForLine("admission branch=direct commandId=md-a delivery=startNow");
		await stderr.waitForLine("admission branch=queue commandId=md-b delivery=queue");
	} finally {
		b.child.kill();
	}
});

test("modelDeferred：忙碌排队不带显式模型——ACK 与 queueItem 均无降级标记（显式性边界）", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	try {
		await createAndSubscribe(b, "md-implicit", 1);
		await sendCommand(b, 10, { commandId: "mi-a", sessionId: "md-implicit", type: "sendText", payload: { text: "A".repeat(400) } });
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "md-implicit", { label: "A turn.started" });

		// 不带 modelSelection：桥接内部会回填会话当前模型进台账，但那不是用户显式选择，
		// 不得挂降级标记（deepEqual 锁死 ACK 无多余字段）。
		const ack = await sendCommand(b, 11, { commandId: "mi-b", sessionId: "md-implicit", type: "sendText", payload: { text: "排队B无模型", requestedDelivery: "queue" } });
		assert.deepEqual(ack.result.result, { type: "inputAccepted", delivery: "queue", inputId: "mi-b" });

		await b.waitFor(() => snapshotWithQueue(b, "md-implicit", 1) !== undefined, { timeoutMs: 10000, label: "B 进队列快照" });
		const item = snapshotWithQueue(b, "md-implicit", 1).queue.items[0];
		assert.equal("fallbackReasonCode" in item.delivery, false, "非显式模型选择（会话默认回填）不得挂降级标记");
		await waitForAssistantReply(b, "md-implicit", "排队B无模型");
	} finally {
		b.child.kill();
	}
});

test("modelDeferred：忙时 startNow 选择不同模型进入托管队列，保留选择并明确延后标记", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	const stderr = collectStderr(b);
	try {
		await createAndSubscribe(b, "md-steer", 1);
		await sendCommand(b, 10, { commandId: "ms-a", sessionId: "md-steer", type: "sendText", payload: { text: "S".repeat(400) } });
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "md-steer", { label: "A turn.started" });

		const ack = await sendCommand(b, 11, {
			commandId: "ms-d",
			sessionId: "md-steer",
			type: "sendText",
			payload: { text: "插话D带模型", requestedDelivery: "startNow", modelSelection: MOCK_MINI },
		});
		assert.equal(ack.result.result.delivery, "queue");
		assert.equal(ack.result.result.fallbackReasonCode, "stepcode.community.optionsDeferred", "新选择不能改变活动轮，ACK 明确标记空闲执行");

		await b.waitFor(() => snapshotWithQueue(b, "md-steer", 1) !== undefined, { timeoutMs: 10000, label: "插话进队列快照" });
		const item = snapshotWithQueue(b, "md-steer", 1).queue.items[0];
		assert.equal(item.steer.state, "notRequested");
		assert.equal(item.modelSelection.modelId, "mock-mini");
		assert.equal(item.delivery.fallbackReasonCode, "stepcode.community.optionsDeferred");
		await stderr.waitForLine("admission branch=queue commandId=ms-d delivery=queue");
	} finally {
		b.child.kill();
	}
});

test("modelDeferred：idle 显式模型直发——模型真实落定且 ACK 无降级标记", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "md-idle", 1);
		const ack = await sendCommand(b, 10, { commandId: "md-idle-1", sessionId: "md-idle", type: "sendText", payload: { text: "空闲切模型", modelSelection: MOCK_MINI } });
		assert.equal(ack.result.status, "accepted");
		assert.deepEqual(ack.result.result, { type: "inputAccepted", delivery: "startNow", inputId: "md-idle-1" }, "idle 直发（模型已先落定）ACK 不得带降级标记");
		const reply = await waitForAssistantReply(b, "md-idle", "空闲切模型");
		assert.equal(reply.model, "mock-mini", "idle 显式模型必须真实生效（先落定再发送）");
	} finally {
		b.child.kill();
	}
});
