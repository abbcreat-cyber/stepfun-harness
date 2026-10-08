/**
 * input-admission-queue 套件（P0-02 复现测试）：sendText 按 requestedDelivery/
 * followupMode 三分流（prompt/followUp/steer）+ 台账 + queue_update 投影 + 两条 stop。
 *
 * 依据 docs/step-input-admission-queue-spec.md：
 * - ACK delivery 如实（idle=startNow；queue/steer=queue）；inputId=commandId。
 * - busy 分流显式拒绝不得吞成假 ACK（rpc-client success 检查 + markFailed 回滚）。
 * - stop 保留队列项（autoDrain=false + pauseReason=stopped）且不再执行。
 * - 能力诚实：queueEdit/sendQueuedNow allowed=false；setFollowupMode 真支持 queue。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { launchBridge } from "./helpers.mjs";
import { InputLedger, decideAdmission } from "../src/input-admission.mjs";
import { makeConversationSnapshot } from "../src/wire-shapes.mjs";

const PNG_B = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6]).toString("base64");

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

function lastSnapshot(b, sessionId) {
	return b.frames
		.filter((f) => f.params?.topic === `conversation/${sessionId}` && f.params.frame?.payload?.snapshot?.rows)
		.at(-1)?.params.frame.payload.snapshot;
}

function snapshotWithQueue(b, sessionId, count) {
	return b.frames
		.filter((f) => f.params?.topic === `conversation/${sessionId}` && f.params.frame?.payload?.snapshot?.queue?.items.length === count)
		.at(-1)?.params.frame.payload.snapshot;
}

test("queue：sendText idle ACK delivery=startNow 且 inputId=commandId", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "q-idle", 1);
		const ack = await sendCommand(b, 10, { commandId: "q-idle-send", sessionId: "q-idle", type: "sendText", payload: { text: "空闲直发" } });
		assert.equal(ack.result.status, "accepted");
		assert.deepEqual(ack.result.result, { type: "inputAccepted", delivery: "startNow", inputId: "q-idle-send" });
		await b.waitFor((f) => f.params?.type === "turn.completed" && f.params.sessionId === "q-idle", { timeoutMs: 20000, label: "turn.completed" });
		const userRow = lastSnapshot(b, "q-idle").rows.window.find((r) => r.kind === "userInput");
		assert.equal(userRow.text, "空闲直发");
		assert.equal(userRow.sourceCommandId, "q-idle-send");
	} finally {
		b.child.kill();
	}
});

test("queue：忙碌排队 B/C 连续提交互不覆盖，续跑按序且 userInput 行归属正确", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	try {
		await createAndSubscribe(b, "q-busy", 1);
		const ackA = await sendCommand(b, 10, { commandId: "q-a", sessionId: "q-busy", type: "sendText", payload: { text: "A".repeat(400) } });
		assert.equal(ackA.result.result.delivery, "startNow");
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-busy", { label: "A turn.started" });
		const ackB = await sendCommand(b, 11, { commandId: "q-b", sessionId: "q-busy", type: "sendText", payload: { text: "排队B", requestedDelivery: "queue" } });
		const ackC = await sendCommand(b, 12, { commandId: "q-c", sessionId: "q-busy", type: "sendText", payload: { text: "排队C", requestedDelivery: "queue" } });
		assert.deepEqual(ackB.result.result, { type: "inputAccepted", delivery: "queue", inputId: "q-b" });
		assert.deepEqual(ackC.result.result, { type: "inputAccepted", delivery: "queue", inputId: "q-c" });
		await b.waitFor(() => snapshotWithQueue(b, "q-busy", 2) !== undefined, { timeoutMs: 10000, label: "快照 queue.items 两项" });
		const queued = snapshotWithQueue(b, "q-busy", 2);
		assert.deepEqual(queued.queue.items.map((i) => i.text), ["排队B", "排队C"]);
		assert.deepEqual(queued.queue.items.map((i) => i.queueItemId), ["qi_q-b", "qi_q-c"]);
		assert.ok(queued.queue.items.every((i) => i.sourceCommandId === i.sourceCommandId && i.kind === "sendText"));
		await b.waitFor(() => b.frames.filter((f) => f.params?.type === "turn.completed" && f.params.sessionId === "q-busy").length >= 3, { timeoutMs: 40000, label: "三轮完成" });
		const final = lastSnapshot(b, "q-busy");
		const texts = final.rows.window.filter((r) => r.kind === "userInput").map((r) => r.text);
		assert.ok(texts.indexOf("排队B") < texts.indexOf("排队C"), "B 先于 C 续跑");
		const rowB = final.rows.window.find((r) => r.kind === "userInput" && r.text === "排队B");
		const rowC = final.rows.window.find((r) => r.kind === "userInput" && r.text === "排队C");
		assert.equal(rowB.sourceCommandId, "q-b");
		assert.equal(rowC.sourceCommandId, "q-c");
		assert.equal(final.queue.items.length, 0, "续跑完成后队列清空");
	} finally {
		b.child.kill();
	}
});

test("queue：插话 busy+startNow 降级 steer，ACK=queue 近似记录，userInput 行立即可见", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	try {
		await createAndSubscribe(b, "q-steer", 1);
		await sendCommand(b, 10, { commandId: "q-s-a", sessionId: "q-steer", type: "sendText", payload: { text: "S".repeat(400) } });
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-steer", { label: "A turn.started" });
		const ack = await sendCommand(b, 11, { commandId: "q-d", sessionId: "q-steer", type: "sendText", payload: { text: "插话D内容", requestedDelivery: "startNow" } });
		assert.deepEqual(ack.result.result, { type: "inputAccepted", delivery: "queue", inputId: "q-d" });
		await b.waitFor(() => snapshotWithQueue(b, "q-steer", 1) !== undefined, { timeoutMs: 10000, label: "插话进队列快照" });
		const snap = snapshotWithQueue(b, "q-steer", 1);
		const item = snap.queue.items[0];
		assert.equal(item.text, "插话D内容");
		assert.equal(item.steer.state, "steering");
		assert.equal(item.delivery.fallbackReasonCode, "stepcode.community.noAtomicPreempt");
		await b.waitFor(() => lastSnapshot(b, "q-steer")?.rows?.window?.some((r) => r.kind === "userInput" && r.text === "插话D内容"), { timeoutMs: 10000, label: "插话 userInput 行立即可见" });
		assert.equal(b.frames.filter((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-steer").length, 1, "插话不另起 turn");
	} finally {
		b.child.kill();
	}
});

// R7 插话轮：工具间隙注入契约（mock 经 mock-steering.mjs 对齐底座 agent-loop.ts runLoop——
// 每个 turn 结束后轮询 steering 池，命中则在同一 agent run 内注入并应答）。
// 三方对证的可观测信号：插话应答行（「已收到插话：…」）的帧序必须晚于工具行、
// 早于 turn.completed，且全程只有一个 turn.started（证明在当前任务内生效，不是任务
// 结束后另起 run 补跑——R3 真机曾观察到纯生成任务插话在主任务完成后才执行的形态）。
test("queue：工具间隙插话——busy+startNow 在当前 run 的工具间隙注入（不等任务结束）", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "80" });
	try {
		await createAndSubscribe(b, "q-gap", 1);
		await sendCommand(b, 10, { commandId: "q-gap-a", sessionId: "q-gap", type: "sendText", payload: { text: "mock:tool" } });
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-gap", { label: "A turn.started" });
		const ack = await sendCommand(b, 11, { commandId: "q-gap-s", sessionId: "q-gap", type: "sendText", payload: { text: "中途插话：后面不用做了", requestedDelivery: "startNow" } });
		assert.deepEqual(ack.result.result, { type: "inputAccepted", delivery: "queue", inputId: "q-gap-s" }, "busy+startNow 路由与降级标记契约保持（steer 近似）");

		// 插话应答行必须在当前 run 内到达（晚于工具行、早于 turn.completed）。
		// 注意流式分片是 8 字符/片，匹配子串不得跨片（首片「已收到插话：中途」内取前缀）。
		await b.waitFor((f) => JSON.stringify(f).includes("已收到插话"), { timeoutMs: 20000, label: "插话应答帧" });
		const idxTool = b.frames.findIndex((f) => f.params?.frame?.payload?.deltas?.some((d) => d.row?.kind === "toolCall") || f.params?.frame?.payload?.snapshot?.rows?.window?.some((r) => r.kind === "toolCall"));
		const idxAck = b.frames.findIndex((f) => JSON.stringify(f).includes("已收到插话"));
		await b.waitFor((f) => f.params?.type === "turn.completed" && f.params.sessionId === "q-gap", { timeoutMs: 20000, label: "turn.completed" });
		const idxCompleted = b.frames.findIndex((f) => f.params?.type === "turn.completed" && f.params.sessionId === "q-gap");
		assert.ok(idxTool !== -1, "工具行必须可见（mock:tool 剧本）");
		assert.ok(idxAck > idxTool, `插话注入必须在工具行之后（idxTool=${idxTool}, idxAck=${idxAck}）`);
		assert.ok(idxAck < idxCompleted, `插话注入必须在任务收敛前（idxAck=${idxAck}, idxCompleted=${idxCompleted}）`);
		assert.equal(b.frames.filter((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-gap").length, 1, "插话注入不另起 run");
		const final = lastSnapshot(b, "q-gap");
		assert.equal(final.queue.items.length, 0, "run 结束后 steer 近似项随 settleTurn 退场");
		assert.ok(final.rows.window.some((r) => r.kind === "assistantText" && String(r.text).includes("已收到插话：中途插话")), "插话应答进入会话时间线");
	} finally {
		b.child.kill();
	}
});

test("queue：busy 分流被拒不伪造 queue ACK（台账回滚且后续发送不受影响）", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	try {
		await createAndSubscribe(b, "q-reject", 1);
		await sendCommand(b, 10, { commandId: "q-r-a", sessionId: "q-reject", type: "sendText", payload: { text: "R".repeat(400) } });
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-reject", { label: "A turn.started" });
		const rejected = await sendCommand(b, 11, { commandId: "q-r", sessionId: "q-reject", type: "sendText", payload: { text: "mock:queue-reject 假成功", requestedDelivery: "startNow" } });
		assert.ok(rejected.error, "follow_up 显式拒绝必须回错误，不得吞成 accepted");
		await b.waitFor((f) => f.params?.type === "turn.completed" && f.params.sessionId === "q-reject", { timeoutMs: 40000, label: "A 完成" });
		const snap = lastSnapshot(b, "q-reject");
		assert.equal(snap.queue.items.filter((i) => i.sourceCommandId === "q-r").length, 0, "失败项回滚后不得留在队列");
		const after = await sendCommand(b, 12, { commandId: "q-after", sessionId: "q-reject", type: "sendText", payload: { text: "恢复发送" } });
		assert.equal(after.result.result.delivery, "startNow");
		await b.waitFor(() => b.frames.filter((f) => f.params?.type === "turn.completed" && f.params.sessionId === "q-reject").length >= 2, { timeoutMs: 20000, label: "后续发送正常完成" });
	} finally {
		b.child.kill();
	}
});

test("queue：停止后队列去留——v4 stop 保留队列项且不再执行", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	try {
		await createAndSubscribe(b, "q-stop", 1);
		await sendCommand(b, 10, { commandId: "q-st-a", sessionId: "q-stop", type: "sendText", payload: { text: "T".repeat(400) } });
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-stop", { label: "A turn.started" });
		await sendCommand(b, 11, { commandId: "q-st-b", sessionId: "q-stop", type: "sendText", payload: { text: "停止后排队B", requestedDelivery: "queue" } });
		await b.waitFor(() => snapshotWithQueue(b, "q-stop", 1) !== undefined, { label: "B 入队" });
		await sendCommand(b, 12, { commandId: "q-st-stop", sessionId: "q-stop", type: "stop", payload: {} });
		await b.waitFor((f) => f.params?.type === "turn.completed" && f.params.sessionId === "q-stop", { timeoutMs: 20000, label: "stop 后 A 终态" });
		const snap = lastSnapshot(b, "q-stop");
		assert.deepEqual(snap.queue.items.map((i) => i.text), ["停止后排队B"], "stop 保留队列项");
		assert.equal(snap.queue.autoDrain, false);
		assert.equal(snap.queue.pauseReason, "stopped");
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(b.frames.filter((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-stop").length, 1, "停止后队列不再执行");
		assert.equal(lastSnapshot(b, "q-stop").queue.items.length, 1);
	} finally {
		b.child.kill();
	}
});

test("queue：停止后队列去留——legacy session/stop 同样保留且不执行", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	try {
		await createAndSubscribe(b, "q-lstop", 1);
		await sendCommand(b, 10, { commandId: "q-ls-a", sessionId: "q-lstop", type: "sendText", payload: { text: "L".repeat(400) } });
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-lstop", { label: "A turn.started" });
		await sendCommand(b, 11, { commandId: "q-ls-b", sessionId: "q-lstop", type: "sendText", payload: { text: "legacy排队B", requestedDelivery: "queue" } });
		await b.waitFor(() => snapshotWithQueue(b, "q-lstop", 1) !== undefined, { label: "B 入队" });
		b.send({ id: 12, method: "session/stop", params: { sessionId: "q-lstop" } });
		await b.waitFor((f) => f.id === 12, { label: "legacy stop 响应" });
		await b.waitFor((f) => f.params?.type === "turn.completed" && f.params.sessionId === "q-lstop", { timeoutMs: 20000, label: "stop 后终态" });
		const snap = lastSnapshot(b, "q-lstop");
		assert.deepEqual(snap.queue.items.map((i) => i.text), ["legacy排队B"]);
		assert.equal(snap.queue.pauseReason, "stopped");
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(b.frames.filter((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-lstop").length, 1);
	} finally {
		b.child.kill();
	}
});

test("queue：图片不串槽——排队 B 的图片只进 B 的运行", async () => {
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	try {
		await createAndSubscribe(b, "slot-b", 1);
		await createAndSubscribe(b, "slot-a", 5);
		const bytes = Buffer.from(PNG_B, "base64");
		const p = { sessionId: "slot-b", connectionId: "slot-b-img", uploadId: "slot-b-up", fileName: "b.png", mime: "image/png", totalBytes: bytes.length, totalChunks: 1, checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
		b.send({ id: 20, method: "v4/attachment/begin", params: p });
		await b.waitFor((f) => f.id === 20, { label: "begin" });
		b.send({ id: 21, method: "v4/attachment/chunk", params: { ...p, chunkIndex: 0, dataBase64: PNG_B } });
		await b.waitFor((f) => f.id === 21, { label: "chunk" });
		b.send({ id: 22, method: "v4/attachment/commit", params: p });
		const refB = (await b.waitFor((f) => f.id === 22, { label: "commit" })).result.ref;
		await sendCommand(b, 10, { commandId: "b-long", sessionId: "slot-b", type: "sendText", payload: { text: "B".repeat(400) } });
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "slot-b", { label: "B turn.started" });
		const ackQ = await sendCommand(b, 11, { commandId: "b-queued", sessionId: "slot-b", type: "sendText", payload: { text: "", attachments: [{ ref: refB, fileName: "b.png", mime: "image/png", bytes: bytes.length }], requestedDelivery: "queue" } });
		assert.equal(ackQ.result.result.delivery, "queue");
		const ackA = await sendCommand(b, 12, { commandId: "a-hello", sessionId: "slot-a", type: "sendText", payload: { text: "A普通输入" } });
		assert.equal(ackA.result.result.delivery, "startNow");
		await b.waitFor(() => b.frames.filter((f) => f.params?.type === "turn.completed" && f.params.sessionId === "slot-b").length >= 2, { timeoutMs: 40000, label: "B 两轮完成" });
		const snapB = lastSnapshot(b, "slot-b");
		const queuedRow = snapB.rows.window.find((r) => r.kind === "userInput" && r.sourceCommandId === "b-queued");
		assert.equal(queuedRow.attachments[0].ref, refB, "排队图片只出现在 B 的运行");
		const echoB = snapB.rows.window.filter((r) => r.kind === "assistantText").map((r) => r.text).join("");
		assert.ok(echoB.includes(PNG_B), "B 的续跑应 echo 图片");
		const snapA = lastSnapshot(b, "slot-a");
		assert.ok(snapA.rows.window.every((r) => !r.attachments?.length), "A 的行不带 B 的附件");
		assert.ok(!JSON.stringify(snapA.rows.window).includes(PNG_B), "A 不得 echo B 的图片");
	} finally {
		b.child.kill();
	}
});

test("queue：setFollowupMode queue 生效进快照，guide 明确不支持", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "q-mode", 1);
		const ack = await sendCommand(b, 10, { commandId: "q-fm", sessionId: "q-mode", type: "setFollowupMode", payload: { mode: "queue" } });
		assert.equal(ack.result.status, "accepted");
		await b.waitFor(() => lastSnapshot(b, "q-mode")?.config?.followupMode === "queue", { label: "快照 followupMode=queue" });
		const guide = await sendCommand(b, 11, { commandId: "q-fm-guide", sessionId: "q-mode", type: "setFollowupMode", payload: { mode: "guide" } });
		assert.ok(guide.error, "guide 模式未实现必须显式拒绝");
	} finally {
		b.child.kill();
	}
});

test("queue：guide 模式忙碌发送被拒——stderr 落 admission branch=reject 取证日志（spec §10）", async () => {
	// R3 评审 low：reject 分支的准入决策日志此前无断言（guide 拒绝场景在 bridge 日志无痕
	// 即无护栏）。E2E 可达通道是 sendText payload 的 requestedDelivery=guide——会话级
	// followupMode 无法设为 guide（setFollowupMode 对 guide 显式拒绝，
	// primarySession.followupMode 恒 queue），而 decideAdmission 对
	// busy+requestedDelivery=guide 与 busy+followupMode=guide 同判 reject
	// （纯函数表已锁，见上）；本用例钉住 E2E 链路：拒绝如实回错 + 取证日志行。
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "60" });
	// helpers 返回的 stderr 是启动时的死快照；自行挂监听拿活体（同 queue-model-deferred 手法）。
	let stderrText = "";
	b.child.stderr.on("data", (chunk) => { stderrText += chunk; });
	try {
		await createAndSubscribe(b, "q-guide", 1);
		await sendCommand(b, 10, { commandId: "q-gd-a", sessionId: "q-guide", type: "sendText", payload: { text: "G".repeat(400) } });
		await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === "q-guide", { label: "A turn.started" });

		const rejected = await sendCommand(b, 11, { commandId: "q-gd", sessionId: "q-guide", type: "sendText", payload: { text: "guide 模式被拒", requestedDelivery: "guide" } });
		assert.ok(rejected.error, "guide 跟进模式必须显式拒绝（不伪造 accepted ACK）");
		assert.equal(rejected.error.code, -32000);

		// 取证日志（session-lifecycle admitAndSend：reject 也是准入决策，抛错前落日志）：
		// 轮询等待 stderr 出现该行（日志经管道异步到达）。
		const expected = "admission branch=reject commandId=q-gd delivery=queue";
		const deadline = Date.now() + 10000;
		while (!stderrText.includes(expected)) {
			if (Date.now() > deadline) throw new Error(`等待 admission reject 日志超时；期望含「${expected}」；stderr=${stderrText}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	} finally {
		b.child.kill();
	}
});

test("queue：能力一致——queueEdit 与 sendQueuedNow 已接通", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "q-avail", 1);
		await b.waitFor(() => lastSnapshot(b, "q-avail") !== undefined, { label: "snapshot" });
		const avail = lastSnapshot(b, "q-avail").availability;
		assert.deepEqual(avail.queueEdit, { allowed: true });
		assert.deepEqual(avail.sendQueuedNow, { allowed: true });
		assert.equal(avail.setFollowupMode.allowed, true);
	} finally {
		b.child.kill();
	}
});

test("queue：worker 级 commandId 顺序重发回放缓存 ACK 不重复执行", async () => {
	const b = launchBridge([], {}, { entry: "session" });
	try {
		await createAndSubscribe(b, "q-replay", 1);
		const first = await sendCommand(b, 10, { commandId: "q-replay-1", sessionId: "q-replay", type: "sendText", payload: { text: "重放探测" } });
		assert.deepEqual(first.result.result, { type: "inputAccepted", delivery: "startNow", inputId: "q-replay-1" });
		await b.waitFor((f) => f.params?.type === "turn.completed", { timeoutMs: 20000, label: "turn.completed" });
		const replay = await sendCommand(b, 11, { commandId: "q-replay-1", sessionId: "q-replay", type: "sendText", payload: { text: "重放探测" } });
		assert.deepEqual(replay.result, first.result, "顺序重发回放缓存 ACK");
		await new Promise((r) => setTimeout(r, 800));
		assert.equal(b.frames.filter((f) => f.params?.type === "turn.started").length, 1, "不得重复执行");
	} finally {
		b.child.kill();
	}
});

test("queue：decideAdmission 纯函数表驱动（含 followupMode 缺省 queue 与 guide 拒绝）", () => {
	const reject = { route: "reject", delivery: "queue", reasonCode: "stepcode.community.guideNotWired" };
	const cases = [
		[{ busy: false, requestedDelivery: "queue" }, { route: "prompt", delivery: "startNow" }],
		[{ busy: false, requestedDelivery: "startNow" }, { route: "prompt", delivery: "startNow" }],
		[{ busy: true, requestedDelivery: "queue" }, { route: "followUp", delivery: "queue" }],
		[{ busy: true }, { route: "followUp", delivery: "queue" }],
		[{ busy: true, followupMode: "queue" }, { route: "followUp", delivery: "queue" }],
		[{ busy: true, followupMode: "guide" }, reject],
		[{ busy: true, requestedDelivery: "guide" }, reject],
	];
	for (const [input, expected] of cases) {
		assert.deepEqual(decideAdmission(input), expected, JSON.stringify(input));
	}
	const steer = decideAdmission({ busy: true, requestedDelivery: "startNow" });
	assert.equal(steer.route, "steer");
	assert.equal(steer.delivery, "queue");
	assert.equal(steer.fallbackReasonCode, "stepcode.community.noAtomicPreempt");
});

test("queue：queue 快照过 conversationSnapshotSchema.parse（.strict() 队列项不炸帧）", async () => {
	// 上游公共入口指向 TS 源码；与 src/workflow/dependencies.mjs 同法注册仓库 TS loader。
	const { register } = await import("tsx/esm/api");
	register();
	const { conversationSnapshotSchema } = await import("@zcode/shared/zcode-protocol-v4");
	const ledger = new InputLedger();
	ledger.begin({ commandId: "schema-b", kind: "sendText", text: "B文本", attachments: [], requestedDelivery: "queue", followupMode: "queue", busy: true, clientId: "schema-client" });
	ledger.markQueued("schema-b");
	const snapshot = makeConversationSnapshot({
		sessionId: "schema-session",
		logEpoch: "schema-epoch",
		seq: 1,
		revision: 1,
		queue: { items: ledger.queueItems(), autoDrain: true },
	});
	conversationSnapshotSchema.parse(snapshot);
	assert.equal(snapshot.queue.items[0].queueItemId, "qi_schema-b");
});

test("queue：sendText 失败台账回滚（markFailed 后假队列项消失且不被下次 agent_start 错归属）", () => {
	const ledger = new InputLedger();
	ledger.begin({ commandId: "rb", kind: "sendText", text: "回滚文本", attachments: [], requestedDelivery: "queue", followupMode: "queue", busy: true, clientId: "rb-client" });
	ledger.markQueued("rb");
	assert.equal(ledger.queueItems().length, 1);
	ledger.markFailed("rb");
	assert.equal(ledger.queueItems().length, 0, "失败项必须从队列回滚");
	assert.equal(ledger.attributeNextRun({ steering: [], followUp: ["回滚文本"] }), null, "失败项不得被 agent_start 错归属");
});
