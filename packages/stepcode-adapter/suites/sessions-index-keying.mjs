/**
 * sessions-index 键控回归（spec §7.6 红基线的防回退测试）。
 *
 * 背景：v4 createSession 带 sessionId 时路由到按 sessionId 键控的独立 worker
 * （src/session-router.mjs route()），其会话摘要按 worker cwd（= 桥进程 cwd）的
 * 规范化键落盘（bin/zcode-bridge-session.mjs 的 createSession 分支 →
 * persistSessionSummary(normalizeWorkspaceKey(cwd))）；持有 sessions-index 订阅的
 * 是 WORKSPACE worker，靠状态文件 + bridge/sessionIndexChanged →
 * bridge/refreshSessionIndex 拉取补发 delta。若订阅 topic 键与摘要落盘键不一致
 * （冒烟红基线：topic=ws-smoke vs 落盘键=cwd），delta 永不到达。
 *
 * 生产约定两者同源：host 以 workspacePath 为桥进程 cwd spawn
 * （packages/services zcodeAgentProcessManager），并以 resolveWorkspaceKey
 * （workspaceIdentity || workspacePath）构造 sessions-index topic
 * （zcodeTaskServiceAdapter → sessionsIndexTopic）。本测试钉住
 * 「桥 cwd=workspace 目录 + 同键订阅」组合下 delta 必达、fromSeq 衔接 snapshot、
 * 摘要落盘在同键分桶——任何一环键控漂移都会让本测试超时失败。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBridge, waitForExit } from "./helpers.mjs";

/** v4/conversation/frame 的 params 是 topic wire 信封（payload 在 params.frame.payload）。 */
const framePayloadOf = (frame) => frame.params?.frame?.payload ?? frame.params?.payload;

test("v4 createSession（独立 worker）摘要按桥 cwd 键控，同键 sessions-index 订阅收到衔接的 session.upserted delta", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-sessions-index-ws-"));
	// 桥 normalizeWorkspaceKey 同款规范化（"/"→"\"+小写），订阅键必须与落盘键一致。
	const workspaceKey = workspaceDir.replaceAll("/", "\\").toLowerCase();
	const topic = `sessions-index/${workspaceKey}`;
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-sessions-index-state-"));
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		// 1. 订阅 sessions-index（落在 WORKSPACE worker），拿空基线 snapshot 与 toSeq。
		b.send({
			id: 1,
			method: "v4/conversation/subscribe",
			params: { topic, connectionId: "conn-keying-1", clientMode: "desktop-continuous" },
		});
		const ack = await b.waitFor((f) => f.id === 1, { label: "sessions-index subscribe ack" });
		assert.ok(ack.result?.ack?.subscriptionId, "subscribe ACK 带 subscriptionId");
		const snapshot = await b.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params?.topic === topic && framePayloadOf(f)?.kind === "snapshot",
			{ label: "sessions-index 初始 snapshot" },
		);
		const snapshotToSeq = snapshot.params.frame?.toSeq ?? snapshot.params.toSeq;
		assert.ok(Number.isInteger(snapshotToSeq), "snapshot.toSeq 是整数");

		// 2. 第二个会话：v4 createSession 带 sessionId → 独立 worker；其摘要键=worker
		//    cwd=桥 cwd=workspaceDir，与订阅 topic 键同源。
		b.send({
			id: 2,
			method: "v4/command",
			params: {
				commandId: "cmd-keying-create",
				clientId: "keying-suite",
				sessionId: "step-session-keying-2",
				type: "createSession",
				payload: { config: { modelSelection: { providerId: "step", modelId: "step-5-preview" } } },
				issuedAt: Date.now(),
			},
		});
		const createAck = await b.waitFor((f) => f.id === 2, { label: "v4 createSession ack" });
		assert.equal(createAck.result?.result?.type, "createSession");

		// 3. 跨 worker 补发：状态文件 + refresh 拉取后，同键订阅必须收到 delta。
		const upsert = await b.waitFor(
			(f) =>
				f.method === "v4/conversation/frame" &&
				f.params?.topic === topic &&
				framePayloadOf(f)?.kind === "deltas" &&
				framePayloadOf(f)?.deltas?.some((d) => d.op === "session.upserted"),
			{ label: "sessions-index session.upserted delta" },
		);
		const inner = upsert.params.frame ?? upsert.params;
		const delta = framePayloadOf(upsert).deltas.find((d) => d.op === "session.upserted");
		assert.equal(delta.session.sessionId, "step-session-keying-2", "delta 携带新建会话摘要");
		assert.equal(inner.fromSeq, snapshotToSeq, "delta.fromSeq 衔接 snapshot.toSeq");
		assert.ok(inner.toSeq > inner.fromSeq, "delta.toSeq 严格递增");
		assert.equal(typeof delta.session.title, "string");
		assert.ok(delta.session.title.length > 0, "摘要标题非空");

		// 4. 落盘键与订阅键一致（状态文件按规范化 workspace 键分桶）。
		const persisted = JSON.parse(readFileSync(join(stateDir, "sessions-index.json"), "utf8"));
		assert.ok(Array.isArray(persisted.workspaces?.[workspaceKey]), "状态文件包含同 workspace 键的桶");
		assert.ok(
			persisted.workspaces[workspaceKey].some((s) => s.sessionId === "step-session-keying-2"),
			"新会话摘要在该键下",
		);
	} finally {
		b.child.stdin.end();
		try {
			await waitForExit(b.child, { label: "桥退出（键控摘要落盘、清理临时目录前）" });
		} catch (error) {
			// R4 low ⑨：waitForExit 超时已自行 kill 桥；此处吞掉退出等待错误，
			// 保证下方 rmSync 必达（tmpdir 不泄漏、也避免双故障顶替原始断言错误），
			// 只留诊断痕迹、不 rethrow。
			console.error(`[sessions-index-keying] 桥退出等待失败（继续清理临时目录）: ${error?.message ?? error}`);
		}
		// R5 评审 low：两处 rmSync 各自 try/catch——单个目录清理失败（Windows 上
		// EBUSY/EPERM 等瞬时占用）只留诊断痕迹，不得顶替 try 体里冒泡的原始断言
		// 错误，且另一目录仍要被清理。
		try {
			rmSync(workspaceDir, { recursive: true, force: true });
		} catch (cleanupError) {
			console.error(`[sessions-index-keying] 清理 workspace 临时目录失败: ${cleanupError?.message ?? cleanupError}`);
		}
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch (cleanupError) {
			console.error(`[sessions-index-keying] 清理 state 临时目录失败: ${cleanupError?.message ?? cleanupError}`);
		}
	}
});
