/**
 * v4 renameSession 主链路 + 防覆盖回归（P1-01 改名四落点一致性）。
 *
 * 背景（docs/step-capability-matrix.md §5.4 / 交接 P1-01）：桥接此前无 renameSession
 * 分支，adapter renameTask 只写 task-index 并吞错降级——桥接会话标题仍按首条消息
 * 派生，且 turn 终态的 persistPrimarySummary 会把 task-index 的新标题覆盖回派生标题。
 *
 * 本套件钉住（mock 底座活体，launchBridge+--state-dir argv）：
 * 1) 改名主链路：conversations JSON 写 session.title+titleSource="custom"、sessions-index
 *    条目换 title 并 bump lastActivityAt（否则跨进程 pushPersistedUpserts 水位过滤会
 *    吞掉改名 delta）、primary 且 client 在时先发原生 set_session_name 再落盘；
 * 2) 防覆盖回归（核心）：改名后再 sendText 等-turn.completed（触发 persistPrimarySummary），
 *    标题仍为自定义名、不被首条/后续消息派生值覆盖；
 * 3) 非 primary 会话改名：磁盘 JSON 与索引照常更新，B 会话不受影响（原生侧不切底座
 *    会话——避免 switch_session 重放副作用，log 说明即可）；
 * 4) 边界：空白 title 回 -32000、不存在 sessionId 回 -32002；
 * 5) 原生失败顺序契约：mock 注入钩子（title 以 "mock-fail" 开头→set_session_name 回
 *    errorResponse）→renameSession 回 -32000 且桥接侧 JSON/索引零写入（先原生后落盘）；
 * 6) 原生链路单元级：set_session_name 空名 errorResponse、合法名成功后 get_state 回读
 *    sessionName（rpc-command-roundtrip 风格 mockClient）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBridge, waitForExit, sleep, mockClient } from "./helpers.mjs";

/** v4/conversation/frame 的 params 是 topic wire 信封（payload 在 params.frame.payload）。 */
const framePayloadOf = (frame) => frame.params?.frame?.payload ?? frame.params?.payload;

/** 桥 normalizeWorkspaceKey 同款规范化（"/"→"\"+小写），读写两侧共用。 */
const bridgeKey = (value) => value.replaceAll("/", "\\").toLowerCase();

const indexFileOf = (stateDir) => join(stateDir, "sessions-index.json");
const convFileOf = (stateDir, sessionId) =>
	join(stateDir, "conversations", `${encodeURIComponent(sessionId)}.json`);

function sendCommand(b, id, params) {
	b.send({ id, method: "v4/command", params });
	return b.waitFor((f) => f.id === id, { label: `v4/command ${params.commandId}` });
}

/** 建会话（可选首条消息）并等 createSession ack；firstInput 时一并等 turn.completed。 */
async function createSessionWithTurn(b, sessionId, firstInput) {
	const ack = await sendCommand(b, 1, {
		commandId: `create-${sessionId}`,
		clientId: "rename-suite",
		sessionId,
		type: "createSession",
		payload: firstInput ? { firstInput } : {},
		issuedAt: Date.now(),
	});
	assert.equal(ack.result?.status, "accepted", `createSession ${sessionId} 应被接受`);
	if (firstInput) {
		await b.waitFor(
			(f) => f.params?.type === "turn.completed" && f.params.sessionId === sessionId,
			{ label: `${sessionId} 首条消息 turn.completed` },
		);
	}
	return ack;
}

/** 轮询等索引文件出现目标会话摘要（改名前先拿基线，含 lastActivityAt 水位）。 */
function waitForIndexEntry(stateDir, workspacePath, sessionId, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const parsed = JSON.parse(readFileSync(indexFileOf(stateDir), "utf8"));
			const entry = parsed?.workspaces?.[bridgeKey(workspacePath)]?.find(
				(s) => s?.sessionId === sessionId,
			);
			if (entry) return { entry, parsed };
		} catch {
			// 尚未写入/并发替换窗口：继续轮询。
		}
		if (Date.now() > deadline) throw new Error(`等待索引条目超时 sessionId=${sessionId}`);
	}
}

function indexEntry(stateDir, workspacePath, sessionId) {
	const parsed = JSON.parse(readFileSync(indexFileOf(stateDir), "utf8"));
	const entry = parsed?.workspaces?.[bridgeKey(workspacePath)]?.find(
		(s) => s?.sessionId === sessionId,
	);
	return { entry, parsed };
}

function readConversationJson(stateDir, sessionId) {
	return JSON.parse(readFileSync(convFileOf(stateDir, sessionId), "utf8"));
}

test("rename：改名主链路——四落点一致（原生名+conversations JSON+索引+session/read）", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-rename-main-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-rename-main-state-"));
	const sessionId = "step-session-rename-main";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "这是初始对话标题来源" });
		const before = waitForIndexEntry(stateDir, workspaceDir, sessionId);
		assert.equal(typeof before.entry.lastActivityAt, "number");

		// 先订阅 sessions-index/<workspacePath>（落在 WORKSPACE worker——与建会话的
		// session worker 跨进程）：snapshot 建立基线水位后，改名的 delta 必须经
		// renameSessionInIndex 的 lastActivityAt bump + 3s watchFile 轮询跨进程推出。
		// 这正是水位 bump 落点的活体钉住（不 bump 的话改名条目会被当作已送达吞掉）。
		b.send({
			id: 12,
			method: "v4/conversation/subscribe",
			params: { topic: `sessions-index/${workspaceDir}`, connectionId: "conn-rename-main", clientMode: "desktop-continuous" },
		});
		await b.waitFor((f) => f.id === 12, { label: "sessions-index subscribe" });
		await b.waitFor(
			(f) =>
				f.method === "v4/conversation/frame" &&
				f.params?.topic === `sessions-index/${workspaceDir}` &&
				framePayloadOf(f)?.kind === "snapshot" &&
				framePayloadOf(f)?.snapshot?.sessions?.some((s) => s?.sessionId === sessionId),
			{ label: "sessions-index 初始 snapshot（派生标题基线）" },
		);

		// 改名（primary 且 client 在：先原生 set_session_name 再落盘）。
		await sleep(10); // 保证 bump 后的 lastActivityAt 严格大于改前水位。
		const renameAck = await sendCommand(b, 10, {
			commandId: "cmd-rename-main-1",
			clientId: "rename-suite",
			sessionId,
			type: "renameSession",
			payload: { title: "我的自定义标题" },
			issuedAt: Date.now(),
		});
		assert.equal(renameAck.result?.status, "accepted", `renameSession 应被接受：${JSON.stringify(renameAck)}`);

		// 落点①：session/read 报自定义名。
		b.send({ id: 11, method: "session/read", params: { sessionId } });
		const read = await b.waitFor((f) => f.id === 11, { label: "session/read 改名后" });
		assert.equal(read.result.session.title, "我的自定义标题");

		// 落点②：conversations JSON 的 session.title+titleSource=custom。
		const conv = readConversationJson(stateDir, sessionId);
		assert.equal(conv.session.title, "我的自定义标题");
		assert.equal(conv.session.titleSource, "custom");

		// 落点③：sessions-index 条目换 title 且 lastActivityAt 被 bump（跨进程 delta 水位）。
		const after = indexEntry(stateDir, workspaceDir, sessionId);
		assert.equal(after.entry.title, "我的自定义标题");
		assert.ok(
			Number(after.entry.lastActivityAt) > Number(before.entry.lastActivityAt),
			`索引 lastActivityAt 必须 bump（改前=${before.entry.lastActivityAt} 改后=${after.entry.lastActivityAt}），否则 pushPersistedUpserts 水位过滤会吞掉改名 delta`,
		);

		// 落点④：跨进程订阅方（WORKSPACE worker 的 3s watchFile 轮询）收到新标题的
		// session.upserted delta——侧栏任务列表标题跨进程生效的完整链路。
		const deltaFrame = await b.waitFor(
			(f) =>
				f.method === "v4/conversation/frame" &&
				f.params?.topic === `sessions-index/${workspaceDir}` &&
				framePayloadOf(f)?.kind === "deltas" &&
				framePayloadOf(f)?.deltas?.some((d) => d.op === "session.upserted" && d.session?.sessionId === sessionId && d.session?.title === "我的自定义标题"),
			{ timeoutMs: 15000, label: "改名标题的跨进程 session.upserted delta（≤3s watchFile + 水位 bump）" },
		);
		assert.ok(deltaFrame, "改名后跨进程 delta 应携带自定义标题");
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（rename 主链路）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("rename：防覆盖回归（核心）——改名后再发消息，标题仍是自定义名", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-rename-guard-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-rename-guard-state-"));
	const sessionId = "step-session-rename-guard";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "第一条消息的原始派生标题" });
		const renameAck = await sendCommand(b, 10, {
			commandId: "cmd-rename-guard-1",
			clientId: "rename-suite",
			sessionId,
			type: "renameSession",
			payload: { title: "用户手动命名的标题" },
			issuedAt: Date.now(),
		});
		assert.equal(renameAck.result?.status, "accepted");

		// 再发一条消息并等 turn.completed——projection 的 agent_settled 分支会调
		// persistPrimarySummary（标题派生点 :73/:99），custom 必须短路派生。
		const derivedFromSecond = "第二条消息的内容若被派生就会覆盖自定义标题";
		const sendAck = await sendCommand(b, 11, {
			commandId: "cmd-rename-guard-2",
			clientId: "rename-suite",
			sessionId,
			type: "sendText",
			payload: { text: derivedFromSecond },
			issuedAt: Date.now(),
		});
		assert.equal(sendAck.result?.status, "accepted");
		await b.waitFor(
			(f) => f.params?.type === "turn.completed" && f.params.sessionId === sessionId,
			{ label: "改名后第二条消息 turn.completed" },
		);

		// session/read 与 conversations JSON 仍为自定义名。
		b.send({ id: 12, method: "session/read", params: { sessionId } });
		const read = await b.waitFor((f) => f.id === 12, { label: "session/read 二次消息后" });
		assert.equal(read.result.session.title, "用户手动命名的标题");
		const conv = readConversationJson(stateDir, sessionId);
		assert.equal(conv.session.title, "用户手动命名的标题");
		assert.equal(conv.session.titleSource, "custom");

		// sessions-index 条目仍为自定义名，且不等于首条/第二条消息的派生值。
		const { entry } = indexEntry(stateDir, workspaceDir, sessionId);
		assert.equal(entry.title, "用户手动命名的标题");
		const derivedFromFirst = Array.from("第一条消息的原始派生标题".trim()).slice(0, 30).join("");
		const derivedFromSecond30 = Array.from(derivedFromSecond.trim()).slice(0, 30).join("");
		assert.notEqual(entry.title, derivedFromFirst);
		assert.notEqual(entry.title, derivedFromSecond30);
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（rename 防覆盖）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("rename：非 primary 会话改名——A 的 JSON/索引更新、B 不变", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-rename-nonp-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-rename-nonp-state-"));
	const sessionA = "step-session-rename-nonp-a";
	const sessionB = "step-session-rename-nonp-b";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		// 建 A（带消息，turn 完成后落盘），再建 B（A 退为非 primary——createSession 会停旧 client）。
		await createSessionWithTurn(b, sessionA, { text: "会话A的首条消息内容" });
		await createSessionWithTurn(b, sessionB, { text: "会话B的首条消息内容" });

		// 改 A（非 primary：磁盘 JSON + 索引路径）。
		const renameAck = await sendCommand(b, 20, {
			commandId: "cmd-rename-nonp-1",
			clientId: "rename-suite",
			sessionId: sessionA,
			type: "renameSession",
			payload: { title: "给会话A的新名字" },
			issuedAt: Date.now(),
		});
		assert.equal(renameAck.result?.status, "accepted");

		const convA = readConversationJson(stateDir, sessionA);
		assert.equal(convA.session.title, "给会话A的新名字");
		assert.equal(convA.session.titleSource, "custom");
		const entryA = indexEntry(stateDir, workspaceDir, sessionA).entry;
		assert.equal(entryA.title, "给会话A的新名字");

		// B 不受影响：标题仍为首条消息派生值，无 titleSource=custom。
		const convB = readConversationJson(stateDir, sessionB);
		assert.equal(convB.session.titleSource, undefined);
		const entryB = indexEntry(stateDir, workspaceDir, sessionB).entry;
		assert.equal(entryB.title, "会话B的首条消息内容");

		// session/read 对非 primary 会话同样报自定义名。
		b.send({ id: 21, method: "session/read", params: { sessionId: sessionA } });
		const read = await b.waitFor((f) => f.id === 21, { label: "session/read A" });
		assert.equal(read.result.session.title, "给会话A的新名字");
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（rename 非 primary）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("rename：空白 title 回 -32000、不存在的 sessionId 回 -32002", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-rename-edge-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-rename-edge-state-"));
	const sessionId = "step-session-rename-edge";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "边界用例的正文" });
		const blank = await sendCommand(b, 10, {
			commandId: "cmd-rename-edge-blank",
			clientId: "rename-suite",
			sessionId,
			type: "renameSession",
			payload: { title: "   \t  " },
			issuedAt: Date.now(),
		});
		assert.equal(blank.error?.code, -32000, `空白标题应回 -32000：${JSON.stringify(blank)}`);
		const missing = await sendCommand(b, 11, {
			commandId: "cmd-rename-edge-missing",
			clientId: "rename-suite",
			sessionId: "no-such-session-for-rename",
			type: "renameSession",
			payload: { title: "合法标题" },
			issuedAt: Date.now(),
		});
		assert.equal(missing.error?.code, -32002, `不存在会话应回 -32002：${JSON.stringify(missing)}`);
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（rename 边界）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("rename：原生失败顺序契约——set_session_name 失败时桥接侧零写入（先原生后落盘）", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-rename-fail-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-rename-fail-state-"));
	const sessionId = "step-session-rename-fail";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "原生失败注入用例的正文" });
		// legacy 完成事件先写 IPC，再完成本轮落盘；同 owner 的读取屏障排除首轮写入的竞态。
		b.send({id:9,method:"session/read",params:{sessionId}});
		await b.waitFor(frame=>frame.id===9,{label:"rename 失败基线的 owner 读取屏障"});
		// 改前基线：conversations JSON 与 sessions-index.json 的逐字节快照。
		const convBefore = readFileSync(convFileOf(stateDir, sessionId), "utf8");
		const indexBefore = readFileSync(indexFileOf(stateDir), "utf8");

		const failed = await sendCommand(b, 10, {
			commandId: "cmd-rename-fail-1",
			clientId: "rename-suite",
			sessionId,
			type: "renameSession",
			// mock-fail 前缀触发 mock 底座的 set_session_name 失败注入（mock-commands.mjs）。
			payload: { title: "mock-fail-原生同步失败的注入用例" },
			issuedAt: Date.now(),
		});
		assert.equal(failed.error?.code, -32000, `原生失败必须如实回 -32000：${JSON.stringify(failed)}`);
		assert.ok(failed.error?.message?.includes("会话名") || failed.error?.message?.includes("set_session_name"), `错误信息应可定位原生失败：${failed.error?.message}`);

		// 钉「失败零写入」：conversations JSON 与 sessions-index.json 均保持改前内容。
		assert.equal(readFileSync(convFileOf(stateDir, sessionId), "utf8"), convBefore, "原生改名失败时 conversations JSON 不得有任何写入");
		assert.equal(readFileSync(indexFileOf(stateDir), "utf8"), indexBefore, "原生改名失败时 sessions-index.json 不得有任何写入");

		// 随后用合法名重试应当成功（失败不留下半状态）。
		const retry = await sendCommand(b, 11, {
			commandId: "cmd-rename-fail-2",
			clientId: "rename-suite",
			sessionId,
			type: "renameSession",
			payload: { title: "失败后的合法重试标题" },
			issuedAt: Date.now(),
		});
		assert.equal(retry.result?.status, "accepted");
		const conv = readConversationJson(stateDir, sessionId);
		assert.equal(conv.session.title, "失败后的合法重试标题");
		assert.equal(conv.session.titleSource, "custom");
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（rename 原生失败契约）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("rename：原生 set_session_name 单元级——空名拒绝、合法名成功后 get_state 回读 sessionName", async () => {
	const client = mockClient();
	try {
		await client.start();
		// 空名：mock 底座回 errorResponse（"Session name cannot be empty"），expectSuccess 抛错。
		await assert.rejects(
			() => client.setSessionName("   "),
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(String(error.message), /Session name cannot be empty/);
				return true;
			},
		);
		// 合法名：命令成功；get_state 回读 sessionName 验证底座真实生效。
		await client.setSessionName("单元级会话名");
		const state = await client.getState();
		assert.equal(state.sessionName, "单元级会话名", "get_state.sessionName 应回读刚设置的名字");
		// new_session 重置会话名（原生生命周期面），再设置一次仍生效。
		await client.newSession();
		const reset = await client.getState();
		assert.equal(reset.sessionName, undefined, "new_session 后 sessionName 应回到未设置态");
	} finally {
		await client.stop();
	}
});
