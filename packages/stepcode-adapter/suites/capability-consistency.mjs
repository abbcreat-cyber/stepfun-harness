/**
 * capability-consistency 套件（能力诚实防线，docs/step-capability-matrix.md 的
 * 机器可读对照）：snapshot.availability.allowed=true 的键，其映射的 v4 命令在
 * bin/zcode-bridge-session.mjs 的 v4/command switch 里必须有真实处理分支——
 * 防止"声明可用却必被 -32602 拒绝"的协议级误报回潮（交接 P0-03）。
 *
 * 静态部分：availability 8 键与 shared/src/zcode-protocol-v4/snapshot.ts:151-161
 * 的 sessionActionAvailabilitySchema 键集一致；allowed=false 必带 reasonCode；
 * default 分支保持 -32602 如实拒绝。
 * 活体部分（mock 底座）：switchModelConfig/setThoughtLevel 真实生效与如实报错、
 * session/list 真实列表、mcp/list 如实 disconnected、session/messages|events
 * -32601、v4/connection/flow 背压真实执行、fork 禁用与 compact 接入。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchBridge } from "./helpers.mjs";
import { makeConversationSnapshot } from "../src/wire-shapes.mjs";

/** snapshot.ts sessionActionAvailabilitySchema 的 8 个必填键（漂移即失败）。 */
const AVAILABILITY_KEYS = [
	"fork",
	"compact",
	"switchModelConfig",
	"setFollowupMode",
	"queueEdit",
	"sendQueuedNow",
	"pauseGoal",
	"resumeGoal",
];

/**
 * availability 键 → 受其管辖的 v4 命令类型（queueEdit 是伞键，三命令共用，
 * 见 shared/src/zcode-protocol-v4/snapshot.ts:151-161 与 command.ts 词表）。
 */
const AVAILABILITY_COMMANDS = {
	fork: ["forkAssistant"],
	compact: ["compact"],
	switchModelConfig: ["switchModelConfig"],
	setFollowupMode: ["setFollowupMode"],
	queueEdit: ["editQueueItem", "reorderQueueItem", "deleteQueueItem"],
	sendQueuedNow: ["sendQueuedNow"],
	pauseGoal: ["pauseGoal"],
	resumeGoal: ["resumeGoal"],
};

function bridgeV4CommandCases() {
	const source = readFileSync(
		fileURLToPath(new URL("../bin/zcode-bridge-session.mjs", import.meta.url)),
		"utf8",
	);
	const start = source.indexOf('"v4/command"');
	assert.ok(start > 0, "桥接源里找不到 v4/command 处理器");
	const end = source.indexOf("default:", start);
	assert.ok(end > start, "v4/command switch 缺少 default 分支");
	const switchSource = source.slice(start, end);
	const cases = new Set(
		[...switchSource.matchAll(/case\s+"([^"]+)":/g)].map((match) => match[1]),
	);
	// default 分支必须保持如实拒绝（-32602），不能吞成成功。
	assert.match(
		source.slice(end, end + 400),
		/unsupported v4 command type/,
		"default 分支必须继续抛 -32602 unsupported",
	);
	return { cases, source };
}

function currentAvailability() {
	return makeConversationSnapshot({
		sessionId: "capability-probe",
		logEpoch: "epoch",
		seq: 1,
		revision: 1,
	}).availability;
}

test("capability：availability 键集与协议 schema 一致（8 键防漂移）", () => {
	assert.deepEqual(Object.keys(currentAvailability()).sort(), [...AVAILABILITY_KEYS].sort());
});

test("capability：allowed=true 的键其全部映射命令必有处理器分支", () => {
	const { cases } = bridgeV4CommandCases();
	const availability = currentAvailability();
	for (const key of AVAILABILITY_KEYS) {
		const entry = availability[key];
		assert.ok(entry, `availability.${key} 缺失`);
		if (entry.allowed !== true) continue;
		for (const commandType of AVAILABILITY_COMMANDS[key]) {
			assert.ok(
				cases.has(commandType),
				`availability.${key}.allowed=true 但 v4/command 无 ${commandType} 分支（能力误报）`,
			);
		}
	}
});

test("capability：renameSession/deleteSession 必有处理器分支（P1-01 已接通，防 -32602 误报回潮）", () => {
	// 这两个命令不在 availability 8 键伞下（协议层按需命令，无 snapshot 声明），
	// 但 adapter renameTask/deleteTask 会真实发送它们——若桥接 case 被误删，
	// 命令将收到 -32602 unsupported 且 adapter 侧表现为改名/删除悄悄失败。
	// default 分支 -32602 如实拒绝语义保持（见下方既有断言）。
	const { cases } = bridgeV4CommandCases();
	assert.ok(cases.has("renameSession"), "v4/command 缺 renameSession 分支（任务重命名将退化为仅本地改名）");
	assert.ok(cases.has("deleteSession"), "v4/command 缺 deleteSession 分支（任务删除将退化为仅本地墓碑）");
});

test("capability：allowed=false 必带非空 reasonCode（可理解的禁用说明）", () => {
	const availability = currentAvailability();
	for (const key of AVAILABILITY_KEYS) {
		const entry = availability[key];
		if (entry.allowed === true) continue;
		assert.equal(entry.allowed, false, `availability.${key} 只能是 true/false`);
		assert.ok(
			typeof entry.reasonCode === "string" && entry.reasonCode.length > 0,
			`availability.${key} 禁用必须带 reasonCode`,
		);
	}
});

test("capability：队列与 compact 已接通，fork/pauseGoal/resumeGoal 仍如实禁用", () => {
	const availability = currentAvailability();
	assert.equal(availability.fork.allowed, false);
	assert.equal(availability.compact.allowed, true);
	assert.equal(availability.queueEdit.allowed, true);
	assert.equal(availability.sendQueuedNow.allowed, true);
	assert.equal(availability.pauseGoal.allowed, false);
	assert.equal(availability.resumeGoal.allowed, false);
	// 重新打开必须同时补处理器分支（上面的分支断言）与本文档化理由。
	const { cases } = bridgeV4CommandCases();
	for (const [key, commands] of Object.entries(AVAILABILITY_COMMANDS)) {
		if (availability[key].allowed === true) continue;
		for (const commandType of commands) {
			assert.equal(
				cases.has(commandType),
				false,
				`availability.${key} 禁用中但 ${commandType} 已有分支——请同步更新声明与本套件`,
			);
		}
	}
});

// ── 活体部分（mock 底座）────────────────────────────────────────────────────

function sendCommand(b, id, params) {
	b.send({ id, method: "v4/command", params });
	return b.waitFor((f) => f.id === id, { label: `v4/command ${params.commandId}` });
}

function sendMethod(b, id, method, params) {
	b.send({ id, method, params });
	return b.waitFor((f) => f.id === id, { label: `${method} ${id}` });
}

async function createAndSubscribe(b, sessionId, baseId, connectionId = `c-${sessionId}`) {
	await sendCommand(b, baseId, { commandId: `create-${sessionId}`, sessionId, type: "createSession", payload: { workspaceId: "ws" } });
	b.send({ id: baseId + 1, method: "v4/conversation/subscribe", params: { topic: `conversation/${sessionId}`, connectionId, clientMode: "desktop-continuous" } });
	await b.waitFor((f) => f.id === baseId + 1, { label: `订阅 ${sessionId}` });
}

function lastSnapshot(b, sessionId) {
	return b.frames
		.filter((f) => f.params?.topic === `conversation/${sessionId}` && f.params.frame?.payload?.snapshot?.rows)
		.at(-1)?.params.frame.payload.snapshot;
}

test("capability：switchModelConfig 真实切模型+切档位，快照反映实际生效值", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "cap-model", 1);
		const ack = await sendCommand(b, 10, {
			commandId: "cap-switch-1",
			sessionId: "cap-model",
			type: "switchModelConfig",
			payload: { provider: "mock", model: "mock-mini", thought: "high" },
		});
		assert.equal(ack.result.status, "accepted");
		await b.waitFor(() => lastSnapshot(b, "cap-model")?.config?.model === "mock-mini", { label: "快照 config.model 切换" });
		const snapshot = lastSnapshot(b, "cap-model");
		assert.equal(snapshot.config.thought, "high");
		assert.equal(snapshot.availability.switchModelConfig.allowed, true);
	} finally {
		b.child.kill();
	}
});

test("capability：switchModelConfig 无效模型/无效档位如实报错（不假成功）", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "cap-model-bad", 1);
		const badModel = await sendCommand(b, 10, {
			commandId: "cap-switch-bad-model",
			sessionId: "cap-model-bad",
			type: "switchModelConfig",
			payload: { provider: "mock", model: "no-such-model", thought: "default" },
		});
		assert.ok(badModel.error, "无效模型必须回错误");
		assert.notEqual(badModel.error.code, 0);
		const badThought = await sendCommand(b, 11, {
			commandId: "cap-switch-bad-thought",
			sessionId: "cap-model-bad",
			type: "switchModelConfig",
			payload: { provider: "step", model: "step-5-preview", thought: "ultra-max" },
		});
		assert.ok(badThought.error?.message.includes("思考档位"), `档位错误信息应可理解：${badThought.error?.message}`);
		// 失败后快照停留在原值（不被请求值污染）。
		const snapshot = lastSnapshot(b, "cap-model-bad");
		assert.equal(snapshot.config.model, "step-5-preview");
	} finally {
		b.child.kill();
	}
});

test("capability：legacy session/setThoughtLevel 真实生效并回真实档位面", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "cap-thought", 1);
		const result = await sendMethod(b, 10, "session/setThoughtLevel", { sessionId: "cap-thought", thoughtLevel: "low" });
		assert.equal(result.result.settings.thoughtLevel.enabled, true);
		assert.equal(result.result.settings.thoughtLevel.current, "low");
		assert.ok(result.result.settings.thoughtLevel.available.some((o) => o.value === "low"));
		const bad = await sendMethod(b, 11, "session/setThoughtLevel", { sessionId: "cap-thought", thoughtLevel: "cosmic" });
		assert.ok(bad.error, "无效档位必须报错");
	} finally {
		b.child.kill();
	}
});

test("capability：session/list 返回真实持久化会话（非空数组）", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "cap-list-1", 1);
		// R2 中危③修正后：v4 createSession 的摘要落盘键跟随 payload.workspaceId
		//（createAndSubscribe 用 "ws"），session/list 必须以同键查询——读写两侧套
		// 同一 normalizeWorkspaceKey（suites/v4-createsession-workspace-id.mjs 钉住）。
		const listed = await sendMethod(b, 10, "session/list", {
			workspace: { workspacePath: "ws", workspaceKey: "ws" },
		});
		const found = listed.result.sessions.find((s) => s.sessionId === "cap-list-1");
		assert.ok(found, `session/list 必须含刚创建的会话：${JSON.stringify(listed.result.sessions.map((s) => s.sessionId))}`);
		assert.equal(found.sessionKind, "interactive");
		assert.equal(found.status, "idle"); // 空草稿
		assert.ok(typeof found.title === "string" && found.title.length > 0);
		assert.ok(Number.isFinite(found.createdAt) && Number.isFinite(found.updatedAt));
	} finally {
		b.child.kill();
	}
});

test("capability：session/messages 与 session/events 回 -32601（明确 unsupported，不回空数组）", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "cap-nolegacy", 1);
		const messages = await sendMethod(b, 10, "session/messages", { sessionId: "cap-nolegacy" });
		assert.equal(messages.error?.code, -32601);
		const events = await sendMethod(b, 11, "session/events", { sessionId: "cap-nolegacy" });
		assert.equal(events.error?.code, -32601);
	} finally {
		b.child.kill();
	}
});

test("capability：mcp/list 如实报告未启动的 MCP server（disconnected+runtime_unavailable）", async () => {
	const b = launchBridge();
	try {
		const listed = await sendMethod(b, 1, "mcp/list", {
			workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
			mcpServers: [
				{ name: "demo-http", type: "http", url: "https://example.invalid", headers: [] },
				{ name: "demo-stdio", command: "node", args: [] },
			],
		});
		assert.equal(listed.result.statuses["demo-http"].status, "disconnected");
		assert.equal(listed.result.statuses["demo-http"].transport, "http");
		assert.equal(listed.result.statuses["demo-http"].failureKind, "runtime_unavailable");
		assert.equal(listed.result.statuses["demo-stdio"].transport, "stdio");
	} finally {
		b.child.kill();
	}
});

test("capability：v4/connection/flow 背压真实执行（saturated 停投递、drained 恢复、非法参数 -32602）", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "cap-flow", 1, "conn-a");
		b.send({ id: 3, method: "v4/conversation/subscribe", params: { topic: "conversation/cap-flow", connectionId: "conn-b", clientMode: "desktop-continuous" } });
		await b.waitFor((f) => f.id === 3, { label: "第二订阅" });
		const subB = b.frames.find((f) => f.id === 3).result.ack.subscriptionId;
		const invalid = await sendMethod(b, 4, "v4/connection/flow", { connectionId: "conn-a" });
		assert.equal(invalid.error?.code, -32602);
		const saturated = await sendMethod(b, 5, "v4/connection/flow", { connectionId: "conn-b", state: "saturated" });
		assert.deepEqual(saturated.result, {});
		const before = b.frames.length;
		const ack = await sendCommand(b, 6, { commandId: "cap-flow-send", sessionId: "cap-flow", type: "sendText", payload: { text: "背压期间的输入" } });
		assert.equal(ack.result.status, "accepted");
		await b.waitFor((f) => f.params?.type === "turn.completed" && f.params.sessionId === "cap-flow", { timeoutMs: 20000, label: "turn.completed" });
		const afterFrames = b.frames.slice(before);
		assert.ok(
			afterFrames.some((f) => f.params?.topic === "conversation/cap-flow" && f.params.deliveryKind === "online"),
			"非饱和连接应收到在线帧",
		);
		assert.equal(
			afterFrames.filter((f) => f.params?.subscriptionId === subB && f.params.deliveryKind === "online").length,
			0,
			"saturated 连接不应收到在线帧",
		);
		const drained = await sendMethod(b, 7, "v4/connection/flow", { connectionId: "conn-b", state: "drained" });
		assert.deepEqual(drained.result, {});
		const beforeResume = b.frames.length;
		await sendCommand(b, 8, { commandId: "cap-flow-mode", sessionId: "cap-flow", type: "setFollowupMode", payload: { mode: "queue" } });
		await b.waitFor(
			(f) => f.params?.subscriptionId === subB && f.params.deliveryKind === "online",
			{ label: "drained 后 conn-b 恢复在线帧" },
		);
		assert.ok(b.frames.length > beforeResume);
	} finally {
		b.child.kill();
	}
});

test("capability：forkAssistant 仍禁用，compact 接受并产生成功标记", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "cap-fork", 1);
		const fork = await sendCommand(b, 10, {
			commandId: "cap-fork-1",
			sessionId: "cap-fork",
			type: "forkAssistant",
			payload: { target: { rowId: 1 } },
		});
		assert.equal(fork.error?.code, -32602);
		const compact = await sendCommand(b, 11, {
			commandId: "cap-compact-1",
			sessionId: "cap-fork",
			type: "compact",
			payload: {},
		});
		assert.equal(compact.result?.status, "accepted");
		await b.waitFor(() => lastSnapshot(b, "cap-fork")?.rows.window.some(r => r.kind === "timelineMarker" && r.marker.type === "compact" && r.marker.status === "success"));
		const snapshot = lastSnapshot(b, "cap-fork");
		assert.equal(snapshot.availability.fork.allowed, false);
		assert.equal(snapshot.availability.compact.allowed, true);
	} finally {
		b.child.kill();
	}
});
