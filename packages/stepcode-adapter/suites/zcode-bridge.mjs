/**
 * zcode-bridge 套件（核心往返与握手）：ZCode Protocol 门面进程的端到端往返
 * （驱动本包 mock）。
 *
 * 覆盖：壳侧 host 调用序列（provider/updateAccountConfig → session/create →
 * session/subscribe → v4/conversation/subscribe → v4/command sendText）、
 * 初始/终态 v4 snapshot 帧、legacy session/event 流、未知方法 -32601、
 * 桌面壳自动追加的 `--surface desktop` 参数容忍、stdin EOF 优雅退出。
 *
 * 同族拆分件（均由 test/index.js 聚合）：zcode-bridge-topics（订阅初始帧与恢复）、
 * zcode-bridge-errors（错误面）、zcode-bridge-sessions-index（索引投影与跨进程状态）、
 * zcode-bridge-turns（turn 流式/并发/幂等）、zcode-bridge-attachments（附件传输）；
 * 启动器在 zcode-bridge-launch.mjs。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBridge } from "./zcode-bridge-launch.mjs";
import { waitForExit } from "./helpers.mjs";

test("bridge：完整 host 调用序列 + v4 帧 + EOF 优雅退出（含 --surface desktop 容忍）", async () => {
	const bridge = launchBridge(["--surface", "desktop"]);
	try {
		bridge.send({ id: 1, method: "provider/updateAccountConfig", params: { revision: "rev-1", providers: { zai: {} } } });
		const accountConfig = await bridge.waitFor((f) => f.id === 1, { label: "accountConfig" });
		assert.equal(accountConfig.result.status, "received");
		assert.equal(accountConfig.result.receivedRevision, "rev-1");
		assert.equal(accountConfig.result.providerCount, 1);

		bridge.send({
			id: 2,
			method: "session/create",
			params: { workspace: { workspacePath: "C:/tmp/suite", workspaceKey: "C:/tmp/suite" } },
		});
		const created = await bridge.waitFor((f) => f.id === 2, { label: "session/create" });
		const sessionId = created.result.session.sessionId;
		assert.equal(created.result.protocol.name, "ZCode Protocol");
		assert.equal(created.result.protocol.version, 1);
		assert.equal(created.result.session.sessionKind, "interactive");
		assert.equal(Array.isArray(created.result.messages), true);

		bridge.send({ id: 3, method: "session/subscribe", params: { sessionId } });
		const subscribed = await bridge.waitFor((f) => f.id === 3, { label: "session/subscribe" });
		assert.equal(subscribed.result.sessionId, sessionId);

		bridge.send({
			id: 4,
			method: "v4/conversation/subscribe",
			params: { topic: `conversation/${sessionId}`, connectionId: "conn-1", clientMode: "desktop-continuous" },
		});
		const v4sub = await bridge.waitFor((f) => f.id === 4, { label: "v4 subscribe" });
		assert.equal(v4sub.result.ack.mode, "snapshot");
		const initialFrame = await bridge.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params.topic === `conversation/${sessionId}`,
			{ label: "初始帧" },
		);
		// 外层信封（Host 路由边界按 topicWireFrameCandidateSchema 校验：wireVersion/kind/deliveryKind/…）。
		assert.equal(initialFrame.params.wireVersion, 3);
		assert.equal(initialFrame.params.kind, "complete");
		assert.equal(initialFrame.params.deliveryKind, "initial");
		assert.equal(typeof initialFrame.params.logicalFrameId, "string");
		assert.ok(initialFrame.params.logicalFrameOrdinal >= 1);
		// 内层 frame（conversationTopicFrameSchema：fromSeq=0 + payload 判别式）。
		assert.equal(initialFrame.params.frame.topic, `conversation/${sessionId}`);
		assert.equal(initialFrame.params.frame.payload.kind, "snapshot");
		assert.equal(initialFrame.params.frame.fromSeq, 0);

		bridge.send({
			id: 5,
			method: "v4/command",
			params: { commandId: "cmd-1", clientId: "suite", sessionId, type: "sendText", payload: { text: "hi" }, issuedAt: Date.now() },
		});
		const ack = await bridge.waitFor((f) => f.id === 5, { label: "v4 command ack" });
		assert.equal(ack.result.status, "accepted");
		assert.equal(ack.result.result.type, "inputAccepted");

		const completed = await bridge.waitFor(
			(f) => f.method === "session/event" && f.params.type === "turn.completed",
			{ timeoutMs: 30000, label: "turn.completed" },
		);
		assert.equal(completed.params.payload.resultType, "success");

		const finalFrame = await bridge.waitFor(
			(f) =>
				f.method === "v4/conversation/frame" &&
				f.params.frame.payload.snapshot?.rows?.window?.length >= 3,
			{ timeoutMs: 20000, label: "终态 snapshot 帧" },
		);
		// 订阅后首帧为 initial，后续帧（turn 终态重放）应为 online，且 ordinal 单调递增。
		assert.equal(finalFrame.params.deliveryKind, "online");
		assert.ok(finalFrame.params.logicalFrameOrdinal > initialFrame.params.logicalFrameOrdinal);
		const kinds = finalFrame.params.frame.payload.snapshot.rows.window.map((row) => row.kind);
		assert.ok(kinds.includes("turnHeader") && kinds.includes("userInput") && kinds.includes("assistantText"));

		// readPresentation 现在已实现（此前 -32601 会毒化 host 的交互偏好 ready 链）；
		// 用一个仍未实现的方法验证未知路径仍回 -32601。
		bridge.send({ id: 6, method: "workspace/hooks/trustGrant", params: {} });
		const notFound = await bridge.waitFor((f) => f.id === 6, { label: "未知方法" });
		assert.equal(notFound.error.code, -32601);

		// 交互偏好链：合法 result 回显，且不再出现 -32601。
		bridge.send({
			id: 7,
			method: "workspace/updateInteractionPreferences",
			params: {
				workspace: { workspacePath: "C:/tmp/suite", workspaceKey: "C:/tmp/suite" },
				preferences: { askUserQuestionAutoResolutionEnabled: true },
			},
		});
		const prefs = await bridge.waitFor((f) => f.id === 7, { label: "交互偏好" });
		assert.equal(prefs.result.askUserQuestionAutoResolutionEnabled, true);
		assert.equal(prefs.result.snoozedInteractionCount, 0);

		// v4 命令幂等查询：已发过的 sendText ack 按 (sessionId, commandId) 回放，未记录的幂等键回 unknown。
		bridge.send({
			id: 8,
			method: "v4/commands/query",
			params: { commands: [{ sessionId, commandId: "cmd-1" }, { sessionId, commandId: "never-issued" }] },
		});
		const queryResult = await bridge.waitFor((f) => f.id === 8, { label: "v4 命令查询" });
		assert.equal(queryResult.result.results.length, 2);
		assert.equal(queryResult.result.results[0].key.commandId, "cmd-1");
		assert.equal(queryResult.result.results[0].result.result.type, "inputAccepted");
		assert.equal(queryResult.result.results[1].result, "unknown");

		bridge.child.stdin.end();
		const { code: exitCode } = await waitForExit(bridge.child, { label: "bridge EOF 优雅退出（完整 host 调用序列）" });
		assert.equal(exitCode, 0);
	} finally {
		if (bridge.child.exitCode === null) bridge.child.kill();
	}
});

test("bridge：未建会话先调 session/subscribe 报错而非崩溃", async () => {
	const bridge = launchBridge();
	try {
		bridge.send({ id: 1, method: "session/subscribe", params: { sessionId: "nonsense" } });
		const error = await bridge.waitFor((f) => f.id === 1, { label: "错误响应" });
		assert.equal(error.error.code, -32002);
		bridge.child.stdin.end();
		const { code: exitCode } = await waitForExit(bridge.child, { label: "bridge EOF 优雅退出（未建会话先订阅报错）" });
		assert.equal(exitCode, 0);
	} finally {
		if (bridge.child.exitCode === null) bridge.child.kill();
	}
});

test("bridge：新会话初始帧 rows.firstRowId 显式为 null（contentRejected 回归护栏）", async () => {
	const bridge = launchBridge();
	try {
		bridge.send({
			id: 1,
			method: "session/create",
			params: { workspace: { workspacePath: "C:/tmp/suite-empty-rows" } },
		});
		const created = await bridge.waitFor((f) => f.id === 1, { label: "session/create" });
		const sessionId = created.result.session.sessionId;

		bridge.send({
			id: 2,
			method: "v4/conversation/subscribe",
			params: { topic: `conversation/${sessionId}`, connectionId: "conn-empty-rows", clientMode: "desktop-continuous" },
		});
		await bridge.waitFor((f) => f.id === 2, { label: "v4 subscribe" });
		const initialFrame = await bridge.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params.topic === `conversation/${sessionId}`,
			{ label: "初始帧" },
		);
		// 新会话初始快照是空 rows（draft，无 row 合法态）：firstRowId 必须显式为 null
		// 且字段存在——省略字段会被壳侧 zod frameSchema 拒收并终态 fault.subscription.contentRejected
		// （rowsWindowSchema: firstRowId z.number().nullable() 必填）。
		const rows = initialFrame.params.frame.payload.snapshot.rows;
		assert.deepEqual(rows.window, []);
		assert.equal(rows.totalCount, 0);
		assert.ok(Object.prototype.hasOwnProperty.call(rows, "firstRowId"), "firstRowId 字段必须存在（可空但不可缺）");
		assert.equal(rows.firstRowId, null);

		bridge.child.stdin.end();
		const { code: exitCode } = await waitForExit(bridge.child, { label: "bridge EOF 优雅退出（新会话初始帧 firstRowId）" });
		assert.equal(exitCode, 0);
	} finally {
		if (bridge.child.exitCode === null) bridge.child.kill();
	}
});
