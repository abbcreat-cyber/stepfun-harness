/**
 * v4 createSession 的 payload.workspaceId 键控回归（R2 中危③）。
 *
 * 背景：v4 createSession 此前硬编码 workspace=process.cwd()、忽略协议必填的
 * payload.workspaceId（packages/shared zcode-protocol-v4/command.ts
 * createSession payload：workspaceId: z.string()）。host 对远程 pane 用
 * workspaceIdentity（remote:ssh:* 等 identity）作 workspaceId 发命令，并以同源
 * resolveWorkspaceKey 构造 sessions-index/<id> 订阅 topic——摘要若仍按桥 cwd
 * 键控落盘，identity 键控 workspace 的任务列表恒空（读侧 persistedSummariesFor
 * 对两侧套同一 normalizeWorkspaceKey，键不一致即查空）。
 *
 * 修法（bin/zcode-bridge-session.mjs createSession 分支）：携带非空
 * payload.workspaceId 时以其为落盘键（workspacePath 透传 session/create →
 * persistPrimarySummary → normalizeWorkspaceKey）；缺省回退 process.cwd() 保持
 * 既有行为（sessions-index-keying.mjs / bridge-smoke 的既有路径）。
 *
 * 本套件钉住两端：
 * 1) 携带 workspaceId（模拟 SSH identity）：摘要落在 workspaceId 的规范化键桶、
 *    不落在桥 cwd 桶，且同键 topic 订阅收到 session.upserted delta（任务列表写入路径）；
 * 2) 缺省（payload 不带 workspaceId）：摘要仍落在桥 cwd 的规范化键桶（现行为不变）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBridge, waitForExit } from "./helpers.mjs";

/** v4/conversation/frame 的 params 是 topic wire 信封（payload 在 params.frame.payload）。 */
const framePayloadOf = (frame) => frame.params?.frame?.payload ?? frame.params?.payload;

/** 桥 normalizeWorkspaceKey 同款规范化（"/"→"\"+小写），读写两侧共用。 */
const bridgeKey = (value) => value.replaceAll("/", "\\").toLowerCase();

/** 轮询等状态文件出现目标键下的会话摘要（worker 侧 ack 前同步落盘，轮询只为稳）。 */
async function waitForPersisted(stateDir, key, sessionId, timeoutMs = 15000) {
	const file = join(stateDir, "sessions-index.json");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const persisted = JSON.parse(readFileSync(file, "utf8"));
			if (persisted?.workspaces?.[key]?.some((s) => s?.sessionId === sessionId)) return persisted;
		} catch {
			// 尚未写入/并发替换窗口：继续轮询。
		}
		if (Date.now() > deadline) throw new Error(`等待摘要落盘超时 key=${key} sessionId=${sessionId}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

test("v4 createSession 携带 workspaceId（SSH identity）：摘要按 workspaceId 键落盘，同键订阅收到 session.upserted", async () => {
	// 模拟远程 pane：host 以 workspaceIdentity（remote:ssh:<host>:<port>:<user>:<posixPath>，
	// 见 shared/remote-workspace-identity.ts）作 payload.workspaceId 与 topic 键。
	const identity = "remote:ssh:build.example:22:alice:/home/alice/proj";
	const topic = `sessions-index/${identity}`;
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-wsid-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-wsid-state-"));
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		// 1. 订阅 workspaceId 键 topic（落在 WORKSPACE worker），拿空基线 snapshot。
		b.send({
			id: 1,
			method: "v4/conversation/subscribe",
			params: { topic, connectionId: "conn-wsid-1", clientMode: "desktop-continuous" },
		});
		await b.waitFor((f) => f.id === 1, { label: "sessions-index subscribe ack" });
		const snapshot = await b.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params?.topic === topic && framePayloadOf(f)?.kind === "snapshot",
			{ label: "sessions-index 初始 snapshot" },
		);
		const snapshotToSeq = snapshot.params.frame?.toSeq ?? snapshot.params.toSeq;
		assert.ok(Number.isInteger(snapshotToSeq), "snapshot.toSeq 是整数");

		// 2. v4 createSession 带 sessionId（独立 worker）+ workspaceId=identity。
		b.send({
			id: 2,
			method: "v4/command",
			params: {
				commandId: "cmd-wsid-create",
				clientId: "wsid-suite",
				sessionId: "step-session-wsid-1",
				type: "createSession",
				payload: { workspaceId: identity, config: { modelSelection: { providerId: "step", modelId: "step-5-preview" } } },
				issuedAt: Date.now(),
			},
		});
		const createAck = await b.waitFor((f) => f.id === 2, { label: "v4 createSession ack" });
		assert.equal(createAck.result?.result?.type, "createSession");

		// 3. 跨 worker 补发：workspaceId 键订阅必须收到本会话的 upsert delta。
		const upsert = await b.waitFor(
			(f) =>
				f.method === "v4/conversation/frame" &&
				f.params?.topic === topic &&
				framePayloadOf(f)?.kind === "deltas" &&
				framePayloadOf(f)?.deltas?.some((d) => d.op === "session.upserted" && d.session?.sessionId === "step-session-wsid-1"),
			{ label: "workspaceId 键控 topic 的 session.upserted delta" },
		);
		const inner = upsert.params.frame ?? upsert.params;
		const delta = framePayloadOf(upsert).deltas.find((d) => d.op === "session.upserted");
		assert.equal(delta.session.sessionId, "step-session-wsid-1", "delta 携带新建会话摘要");
		assert.equal(inner.fromSeq, snapshotToSeq, "delta.fromSeq 衔接 snapshot.toSeq");
		assert.equal(typeof delta.session.title, "string");
		assert.ok(delta.session.title.length > 0, "摘要标题非空");

		// 4. 落盘键 = workspaceId 的规范化键（读侧 persistedSummariesFor 同款），且不落在桥 cwd 键下。
		const persisted = await waitForPersisted(stateDir, identity, "step-session-wsid-1");
		assert.ok(Array.isArray(persisted.workspaces[identity]), "状态文件含不变的 workspace identity 桶");
		const cwdBucket = persisted.workspaces[bridgeKey(workspaceDir)];
		assert.ok(
			!Array.isArray(cwdBucket) || !cwdBucket.some((s) => s?.sessionId === "step-session-wsid-1"),
			"携带 workspaceId 时摘要不得落在桥 cwd 键桶",
		);
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（workspaceId 键落盘、清理临时目录前）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("v4 createSession 缺省 workspaceId：摘要仍按桥 cwd 键落盘（缺省行为不变）", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-wsid-def-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-wsid-def-state-"));
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		b.send({
			id: 1,
			method: "v4/command",
			params: {
				commandId: "cmd-wsid-def",
				clientId: "wsid-suite",
				sessionId: "step-session-wsid-def",
				type: "createSession",
				payload: {},
				issuedAt: Date.now(),
			},
		});
		const createAck = await b.waitFor((f) => f.id === 1, { label: "v4 createSession ack" });
		assert.equal(createAck.result?.result?.type, "createSession");
		// 落盘键仍是桥 cwd 的规范化键（既有行为，bridge-smoke / keying 套件依赖它）。
		await waitForPersisted(stateDir, bridgeKey(workspaceDir), "step-session-wsid-def");
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（缺省键落盘、清理临时目录前）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});
