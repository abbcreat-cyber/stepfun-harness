/**
 * send-model-selection 套件（P0-04 收尾）。
 *
 * 验收点（上一轮状态文档 §4.1 / docs/step-capability-matrix.md §6 的残留项）：
 * sendText 的 payload.modelSelection 与 createSession firstInput 的模型选择必须接到
 * switchModelConfig 已验证的 set_model 链路——切换后同会话续发使用新模型、恢复旧会话
 * 后模型选择仍正确、无效模型如实报错（不假装切换成功）。
 *
 * 底座真实模型的权威观测点：assistantText 行的 model 字段（StepStreamProjection 从
 * message_start 事件的 message.model 取值——那是底座发送时刻的真实模型，不是桥接
 * 会话记录的回显）。快照 config.model 是会话记录投影，仅作辅助断言。
 *
 * 恢复用例依赖 mock 的 switch_session（对齐底座契约：恢复会话不动进程级模型态，
 * 桥接必须自行重放 set_model）。全部走 helpers.launchBridge 的 argv 状态目录通道
 * （spec §8），不依赖任何 STECODE_* 环境变量。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBridge } from "./helpers.mjs";

const MOCK_MINI = { providerId: "mock", modelId: "mock-mini" };

function sendCommand(b, id, params) {
	b.send({ id, method: "v4/command", params });
	return b.waitFor((f) => f.id === id, { label: `v4/command ${params.commandId}` });
}

async function createAndSubscribe(b, sessionId, baseId) {
	await sendCommand(b, baseId, { commandId: `create-${sessionId}`, sessionId, type: "createSession", payload: { workspaceId: "ws" } });
	b.send({ id: baseId + 1, method: "v4/conversation/subscribe", params: { topic: `conversation/${sessionId}`, connectionId: `c-${sessionId}`, clientMode: "desktop-continuous" } });
	await b.waitFor((f) => f.id === baseId + 1, { label: `订阅 ${sessionId}` });
}

function lastSnapshot(b, sessionId) {
	return b.frames
		.filter((f) => f.params?.topic === `conversation/${sessionId}` && f.params.frame?.payload?.snapshot?.rows)
		.at(-1)?.params.frame.payload.snapshot;
}

/** 快照行窗口（rowsSchema 是 { window, totalCount, firstRowId } 包装）。 */
function snapshotRows(b, sessionId) {
	return lastSnapshot(b, sessionId)?.rows?.window ?? [];
}

/** 等待某会话出现对 text 的完整回复行，返回该行（assistantText.model = 底座真实模型）。
 * 注意 predicate 必须判断帧本身（helpers.waitFor 从头重扫全部帧，查全局状态会误命中
 * 旧帧），命中后再从最新快照取行对象。 */
function waitForAssistantReply(b, sessionId, text) {
	const match = (r) => r.kind === "assistantText" && r.state !== "streaming" && r.text?.includes(`mock reply to: ${text}`);
	return b.waitFor(
		(f) => f.params?.topic === `conversation/${sessionId}`
			&& (f.params.frame?.payload?.snapshot?.rows?.window ?? []).some(match),
		{ label: `${sessionId} 的回复行（${text}）` },
	).then(() => snapshotRows(b, sessionId).find(match));
}

function waitTurnCompleted(b, sessionId, afterIndex = 0) {
	return b.waitFor(
		(f) => f.params?.type === "turn.completed" && f.params.sessionId === sessionId && b.frames.indexOf(f) >= afterIndex,
		{ label: `${sessionId} turn.completed` },
	);
}

test("modelSelection：切模型后同会话续发使用新模型（sendText 附带选择真实落定）", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "p004-switch", 1);
		const first = await sendCommand(b, 10, {
			commandId: "p004-send-1",
			sessionId: "p004-switch",
			type: "sendText",
			payload: { text: "第一段", modelSelection: MOCK_MINI },
		});
		assert.equal(first.result.status, "accepted");
		const reply1 = await waitForAssistantReply(b, "p004-switch", "第一段");
		assert.equal(reply1.model, "mock-mini", "首条带模型选择的发送应由新模型执行（底座真实模型）");
		await waitTurnCompleted(b, "p004-switch");

		// 同会话续发：不带 modelSelection，应沿用上一条落定的新模型，而不是回落进程默认。
		const second = await sendCommand(b, 11, {
			commandId: "p004-send-2",
			sessionId: "p004-switch",
			type: "sendText",
			payload: { text: "第二段" },
		});
		assert.equal(second.result.status, "accepted");
		const reply2 = await waitForAssistantReply(b, "p004-switch", "第二段");
		assert.equal(reply2.model, "mock-mini", "续发必须仍用新模型");
		assert.equal(lastSnapshot(b, "p004-switch")?.config?.model, "mock-mini");
	} finally {
		b.child.kill();
	}
});

test("modelSelection：恢复旧会话后模型选择仍正确（restore 重放持久化模型）", async () => {
	const b = launchBridge();
	try {
		// s1 用 mock-mini 跑完一轮。
		await createAndSubscribe(b, "p004-restore", 1);
		await sendCommand(b, 10, {
			commandId: "p004-restore-1",
			sessionId: "p004-restore",
			type: "sendText",
			payload: { text: "切模型轮", modelSelection: MOCK_MINI },
		});
		const reply1 = await waitForAssistantReply(b, "p004-restore", "切模型轮");
		assert.equal(reply1.model, "mock-mini");
		await waitTurnCompleted(b, "p004-restore");

		// 新建 s2：session/create 会重启底座进程，模型回到进程默认 step-5-preview。
		await createAndSubscribe(b, "p004-restore-b", 20);
		assert.equal(lastSnapshot(b, "p004-restore-b")?.config?.model, "step-5-preview", "前置：新会话回到默认模型");

		// 切回 s1 续发（不带 modelSelection）：必须重放 s1 记录的 mock-mini。
		const resumed = await sendCommand(b, 30, {
			commandId: "p004-restore-2",
			sessionId: "p004-restore",
			type: "sendText",
			payload: { text: "恢复后续发" },
		});
		assert.equal(resumed.result.status, "accepted", `恢复后续发不应报错：${resumed.error?.message}`);
		const reply2 = await waitForAssistantReply(b, "p004-restore", "恢复后续发");
		assert.equal(reply2.model, "mock-mini", "恢复旧会话后续发必须仍用该会话记录的模型");
		assert.equal(lastSnapshot(b, "p004-restore")?.config?.model, "mock-mini");
	} finally {
		b.child.kill();
	}
});

test("modelSelection：sendText 附带无效模型如实报错且不发送（不假装切换成功）", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "p004-bad", 1);
		const bad = await sendCommand(b, 10, {
			commandId: "p004-bad-1",
			sessionId: "p004-bad",
			type: "sendText",
			payload: { text: "这条不该发出", modelSelection: { providerId: "mock", modelId: "no-such-model" } },
		});
		assert.ok(bad.error, "无效模型必须回错误，不得回 accepted");
		assert.notEqual(bad.error.code, 0);
		assert.ok(
			bad.error.message.includes("no-such-model") || bad.error.message.includes("模型"),
			`错误信息应指明模型问题：${bad.error.message}`,
		);
		// 消息未发送：无该文本行、无 turn、模型未变。
		await new Promise((resolve) => setTimeout(resolve, 600));
		const snapshot = lastSnapshot(b, "p004-bad");
		assert.ok(
			!snapshotRows(b, "p004-bad").some((r) => JSON.stringify(r).includes("这条不该发出")),
			"被拒消息不得出现在会话行里",
		);
		assert.equal(snapshot?.config?.model, "step-5-preview", "失败后模型停留在原值");
		assert.ok(!b.frames.some((f) => f.params?.type === "turn.completed" && f.params.sessionId === "p004-bad"), "不得有 turn 执行");
		// 会话仍可用：后续正常发送走原模型。
		const ok = await sendCommand(b, 11, {
			commandId: "p004-bad-2",
			sessionId: "p004-bad",
			type: "sendText",
			payload: { text: "恢复验证" },
		});
		assert.equal(ok.result.status, "accepted");
		const reply = await waitForAssistantReply(b, "p004-bad", "恢复验证");
		assert.equal(reply.model, "step-5-preview");
	} finally {
		b.child.kill();
	}
});

test("modelSelection：createSession firstInput 带合法模型真实生效", async () => {
	const b = launchBridge();
	try {
		const ack = await sendCommand(b, 1, {
			commandId: "p004-fi-1",
			sessionId: "p004-firstinput",
			type: "createSession",
			payload: { workspaceId: "ws", firstInput: { text: "首发带模型", modelSelection: MOCK_MINI } },
		});
		assert.equal(ack.result.status, "accepted");
		assert.equal(ack.result.result.input.delivery, "startNow");
		b.send({ id: 3, method: "v4/conversation/subscribe", params: { topic: "conversation/p004-firstinput", connectionId: "c-fi", clientMode: "desktop-continuous" } });
		await b.waitFor((f) => f.id === 3, { label: "订阅 p004-firstinput" });
		const reply = await waitForAssistantReply(b, "p004-firstinput", "首发带模型");
		assert.equal(reply.model, "mock-mini", "firstInput 的模型选择必须真实生效");
		assert.equal(lastSnapshot(b, "p004-firstinput")?.config?.model, "mock-mini");
	} finally {
		b.child.kill();
	}
});

test("modelSelection：createSession firstInput 带无效模型如实报错（不吞错建会话）", async () => {
	const b = launchBridge();
	try {
		const bad = await sendCommand(b, 1, {
			commandId: "p004-fi-bad",
			sessionId: "p004-firstinput-bad",
			type: "createSession",
			payload: { workspaceId: "ws", firstInput: { text: "不该发出", modelSelection: { providerId: "mock", modelId: "no-such-model" } } },
		});
		assert.ok(bad.error, "firstInput 显式模型选择失败必须回错误");
		assert.notEqual(bad.error.code, 0);
		// 不留假会话：该会话 topic 无快照行（会话没建成）。
		assert.ok(!b.frames.some((f) => f.params?.topic === "conversation/p004-firstinput-bad"), "失败创建不得产生会话帧");
		// 默认兜底路径保持启动韧性：不带模型选择仍可正常建会话发送。
		const ok = await sendCommand(b, 2, {
			commandId: "p004-fi-ok",
			sessionId: "p004-firstinput-ok",
			type: "createSession",
			payload: { workspaceId: "ws", firstInput: { text: "默认模型首发" } },
		});
		assert.equal(ok.result.status, "accepted");
		b.send({ id: 4, method: "v4/conversation/subscribe", params: { topic: "conversation/p004-firstinput-ok", connectionId: "c-fiok", clientMode: "desktop-continuous" } });
		await b.waitFor((f) => f.id === 4, { label: "订阅 p004-firstinput-ok" });
		const reply = await waitForAssistantReply(b, "p004-firstinput-ok", "默认模型首发");
		assert.equal(reply.model, "step-5-preview");
	} finally {
		b.child.kill();
	}
});

test("modelSelection：坏模型建会话失败后，旧会话续发走恢复而非静默打进空底座（评审高严重度防回退）", async () => {
	// 直连 session worker（绕过路由层的按会话分派）：坏模型建会话与旧会话续发
	// 落同一 worker，才能复现「底座已被 newSession 换成空会话、桥接仍指旧会话」
	// 的失步形态（走路由入口时新会话可能被派到其它 worker，该形态被掩盖）。
	const b = launchBridge([], {}, { entry: "session" });
	try {
		// s-a 先切到 mock-mini 并跑完一轮：会话记录模型 mock-mini、行落盘。
		await createAndSubscribe(b, "p004-after-fail", 1);
		await sendCommand(b, 10, {
			commandId: "p004-af-1",
			sessionId: "p004-after-fail",
			type: "sendText",
			payload: { text: "首轮", modelSelection: MOCK_MINI },
		});
		const reply1 = await waitForAssistantReply(b, "p004-after-fail", "首轮");
		assert.equal(reply1.model, "mock-mini");
		await waitTurnCompleted(b, "p004-after-fail");

		// 显式坏模型建新会话：报错，但此刻底座进程已被 stop+newSession 换成全新
		// 空会话（模型回进程默认）——若桥接不动状态，旧会话续发会静默打进该空底座。
		const bad = await sendCommand(b, 20, {
			commandId: "p004-af-bad",
			sessionId: "p004-after-fail-new",
			type: "createSession",
			payload: { workspaceId: "ws", firstInput: { text: "坏模型", modelSelection: { providerId: "mock", modelId: "no-such-model" } } },
		});
		assert.ok(bad.error, "前置：坏模型建会话必须报错");

		// 旧会话续发（不带模型选择）：必须走 restoreSession 恢复（switch_session +
		// 模型重放）。恢复路径的可观测标志：续发由会话记录的模型（mock-mini）执行；
		// 失步形态下（桥接指旧状态、底座是空进程）回复行 model 会是 step-5-preview。
		const resumed = await sendCommand(b, 30, {
			commandId: "p004-af-2",
			sessionId: "p004-after-fail",
			type: "sendText",
			payload: { text: "失败后续发" },
		});
		assert.ok(resumed.result, `旧会话续发应通过恢复路径接受，而非报错：${resumed.error?.message}`);
		const reply2 = await waitForAssistantReply(b, "p004-after-fail", "失败后续发");
		assert.equal(reply2.model, "mock-mini", "续发必须重放会话记录的模型（走了恢复路径）");
		// 恢复自磁盘：首轮上下文行仍在，新回复追加其后。
		const rows = snapshotRows(b, "p004-after-fail");
		assert.ok(rows.some((r) => r.kind === "userInput" && r.text === "首轮"), "旧行必须保留（恢复自持久化）");
	} finally {
		b.child.kill();
	}
});
