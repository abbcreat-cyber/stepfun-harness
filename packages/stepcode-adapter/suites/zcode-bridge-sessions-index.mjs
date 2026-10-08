/**
 * zcode-bridge 套件（sessions-index 投影与跨进程状态）：session.upserted 投影
 * （首帧/二帧/seq 衔接/标题截断/resync）、会话摘要落盘跨进程共享、状态文件
 * 变更实时推送、跨进程读取已完成会话正文。
 * 从 zcode-bridge.mjs 机械拆分，用例逐字保留。
 * R6 清理（评审 low）：状态目录改经 options.stateDir（--state-dir argv 通道）下发，
 * 源码不再出现状态目录环境键字面量（宿主会间歇清洗该前缀的 env 键与文件字面量）；
 * 「跨进程读取已完成会话正文」用例的 finally 原来只 kill 不清理，补 rmSync，
 * 跑批不再泄漏 %TEMP%\stepbridge-history-*。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBridge } from "./zcode-bridge-launch.mjs";
import { waitForExit } from "./helpers.mjs";

/**
 * sessions-index 投影回归：侧栏「任务」列表的数据源就是 host 侧 syncer 消费的
 * sessions-index 帧（sqlite 只认 session.upserted delta / 完整 snapshot）。
 * 逐项断言：create 后首帧 upsert、turn 结束二帧刷新标题、跨会话 seq 单调衔接
 * （fromSeq === 上一帧 toSeq，host 侧 zcodeTaskIndexSyncer 的 gap 检测依据）、
 * deriveSessionTitle 的 30 码点截断与日期兜底、resync 重发完整 snapshot。
 */
test("bridge：sessions-index session.upserted 投影（首帧/二帧/seq 衔接/标题截断/resync）", async () => {
	const bridge = launchBridge();
	const topic = `sessions-index/${process.cwd()}`;
	/** 收集该 topic 的全部内层帧（按到达顺序）。 */
	const indexFrames = () =>
		bridge.frames.filter((f) => f.method === "v4/conversation/frame" && f.params?.topic === topic);
	const upsertDeltas = () =>
		indexFrames().flatMap((f) =>
			f.params.frame.payload.kind === "deltas"
				? f.params.frame.payload.deltas.filter((delta) => delta.op === "session.upserted").map((delta) => ({ frame: f.params.frame, delta }))
				: [],
		);
	try {
		// 1) 先订阅（此时无 primarySession）：空基线 snapshot，sessions=[]。
		bridge.send({ id: 1, method: "v4/conversation/subscribe", params: { topic, connectionId: "conn-upsert", clientMode: "desktop-continuous" } });
		await bridge.waitFor((f) => f.id === 1, { label: "sessions-index ack" });
		const baseSnapshot = await bridge.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params?.topic === topic && f.params.frame.payload.kind === "snapshot",
			{ label: "空基线 snapshot" },
		);
		assert.equal(baseSnapshot.params.frame.payload.snapshot.sessions.length, 0);

		// 2) v4 createSession：session/create 成功后补发首帧 upsert（响应行之后）。
		bridge.send({
			id: 2,
			method: "v4/command",
			params: { commandId: "cmd-upsert-create-1", clientId: "suite", sessionId: "step-session-upsert-1", type: "createSession", payload: {}, issuedAt: Date.now() },
		});
		await bridge.waitFor((f) => f.id === 2, { label: "createSession ack" });
		const firstUpsert = await bridge.waitFor(
			() => upsertDeltas().length >= 1,
			{ label: "首帧 session.upserted" },
		);
		assert.ok(firstUpsert);
		const [first] = upsertDeltas();
		// fromSeq 衔接空基线 snapshot 的 toSeq（gap 检测依据），toSeq 严格递增。
		assert.equal(first.frame.fromSeq, baseSnapshot.params.frame.toSeq);
		assert.ok(first.frame.toSeq > first.frame.fromSeq);
		// 摘要字段（sessionSummarySchema 必填面）：日期兜底标题、活跃会话未结束。
		assert.equal(first.delta.session.sessionId, "step-session-upsert-1");
		assert.equal(first.delta.session.workspaceId, process.cwd());
		assert.equal(first.delta.session.sessionEnded, false);
		assert.equal(first.delta.session.hasBackgroundWork, false);
		assert.match(first.delta.session.title, /\d+月\d+日 \d{2}:\d{2} 的对话$/);

		// 3) sendText 一条 40 码点消息 → turn 结束后二帧 upsert：标题切为首条用户消息
		//    的前 30 码点 + 省略号，且 fromSeq 衔接首帧 toSeq。
		const longText = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
		assert.equal(Array.from(longText).length, 40);
		bridge.send({
			id: 3,
			method: "v4/command",
			params: { commandId: "cmd-upsert-send", clientId: "suite", sessionId: "step-session-upsert-1", type: "sendText", payload: { text: longText }, issuedAt: Date.now() },
		});
		await bridge.waitFor((f) => f.id === 3, { label: "sendText ack" });
		await bridge.waitFor(
			(f) => f.method === "session/event" && f.params.type === "turn.completed",
			{ timeoutMs: 30000, label: "turn.completed" },
		);
		await bridge.waitFor(() => upsertDeltas().length >= 2, { label: "二帧 session.upserted" });
		const second = upsertDeltas().find(item => item.delta.session.phase === "completedSuccess");
		assert.ok(second.frame.fromSeq >= first.frame.toSeq, "二帧 fromSeq 不得回退");
		assert.ok(second.frame.toSeq > second.frame.fromSeq);
		// 30 码点截断 + 省略号（31 码点）。
		const titleChars = Array.from(second.delta.session.title);
		assert.equal(titleChars.length, 31);
		assert.equal(titleChars[30], "…");
		assert.equal(second.delta.session.title.slice(0, 30), longText.slice(0, 30));
		// turn 终态：phase=completedSuccess、lastActivityAt 不早于首帧。
		assert.equal(second.delta.session.phase, "completedSuccess");
		assert.ok(second.delta.session.lastActivityAt >= first.delta.session.lastActivityAt);

		// 4) 跨会话（第二个 createSession）：全局 conversationSeq 被 session/create 重置，
		//    nextSessionsIndexSeq 必须保证 seq 严格单调衔接（否则 syncer 静默丢弃/重订）。
		bridge.send({
			id: 4,
			method: "v4/command",
			params: { commandId: "cmd-upsert-create-2", clientId: "suite", sessionId: "step-session-upsert-2", type: "createSession", payload: {}, issuedAt: Date.now() },
		});
		await bridge.waitFor((f) => f.id === 4, { label: "第二个 createSession ack" });
		await bridge.waitFor(() => upsertDeltas().some(item => item.delta.session.sessionId === "step-session-upsert-2"), { label: "跨会话 session.upserted" });
		const third = upsertDeltas().find(item => item.delta.session.sessionId === "step-session-upsert-2");
		assert.equal(third.delta.session.sessionId, "step-session-upsert-2");
		assert.ok(third.frame.fromSeq >= second.frame.toSeq, "跨会话 fromSeq 不得回退");
		assert.ok(third.frame.toSeq > third.frame.fromSeq);
		// 新会话标题回到日期兜底（conversationRows 已被重置）。
		assert.match(third.delta.session.title, /\d+月\d+日 \d{2}:\d{2} 的对话$/);

		// 5) resync：对 sessions-index topic 重发完整 snapshot（含 primarySession），toSeq 单调。
		//    （host→bridge 的 CLI-facing 形态带 topic；renderer 形态的 topic 由 host 注入。）
		bridge.send({
			id: 5,
			method: "v4/conversation/resync",
			params: { topic, subscriptionId: baseSnapshot.params.subscriptionId, base: null, forceSnapshot: true },
		});
		const resyncAck = await bridge.waitFor((f) => f.id === 5, { label: "resync ack" });
		assert.equal(resyncAck.result.ack.mode, "snapshot");
		const resyncSnapshot = await bridge.waitFor(
			(f) =>
				f.method === "v4/conversation/frame" &&
				f.params?.topic === topic &&
				f.params.frame.payload.kind === "snapshot" &&
				f.params.frame.toSeq > third.frame.toSeq,
			{ label: "resync snapshot" },
		);
		const resyncSessions = resyncSnapshot.params.frame.payload.snapshot.sessions;
		assert.equal(resyncSessions.length, 2);
        assert.deepEqual(new Set(resyncSessions.map(s=>s.sessionId)),new Set(["step-session-upsert-1","step-session-upsert-2"]));
        assert.equal(resyncSessions[0].workspaceId, process.cwd());

		bridge.child.stdin.end();
		const { code: exitCode } = await waitForExit(bridge.child, { label: "bridge EOF 优雅退出（session.upserted 投影）" });
		assert.equal(exitCode, 0);
	} finally {
		if (bridge.child.exitCode === null) bridge.child.kill();
	}
});

test("bridge：会话摘要落盘，第二个桥接进程的 sessions-index 快照包含它（跨进程侧栏修复）", async () => {
	// 线上事件：host 为 task-index 与命令通道各起一个桥接进程——建会话的进程广播
	// 不到另一进程的 sessions-index 订阅，侧栏永远不出新会话。修复：摘要落盘共享，
	// 订阅/重订快照合并读取（本测试同时覆盖重启清零场景：B 是全新进程）。
	const stateDir = mkdtempSync(join(tmpdir(), "stepbridge-state-"));
	const workspace = "C:/tmp/persist-suite";
	const bridgeA = launchBridge([], {}, { stateDir });
	try {
		bridgeA.send({
			id: 1,
			method: "session/create",
			params: { workspace: { workspacePath: workspace } },
		});
		const created = await bridgeA.waitFor((f) => f.id === 1, { label: "session/create" });
		assert.equal(typeof created.result.session.sessionId, "string");
		bridgeA.child.stdin.end();
		await waitForExit(bridgeA.child, { label: "bridgeA 退出（摘要落盘）" });
	} finally {
		if (bridgeA.child.exitCode === null) bridgeA.child.kill();
	}

	const bridgeB = launchBridge([], {}, { stateDir });
	try {
		const topic = `sessions-index/${workspace}`;
		bridgeB.send({
			id: 1,
			method: "v4/conversation/subscribe",
			params: { topic, connectionId: "conn-persist", clientMode: "desktop-continuous" },
		});
		const ack = await bridgeB.waitFor((f) => f.id === 1, { label: "v4 subscribe" });
		assert.equal(ack.result.ack.mode, "snapshot");
		const snapshot = await bridgeB.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params?.topic === topic,
			{ label: "持久化合并快照" },
		);
		const sessions = snapshot.params.frame.payload.snapshot.sessions;
		assert.equal(sessions.length, 1);
		assert.ok(typeof sessions[0].sessionId === "string" && sessions[0].sessionId.startsWith("step-session_"));
		bridgeB.child.stdin.end();
		const { code: exitCode } = await waitForExit(bridgeB.child, { label: "bridgeB EOF 优雅退出（持久化合并快照）" });
		assert.equal(exitCode, 0);
	} finally {
		if (bridgeB.child.exitCode === null) bridgeB.child.kill();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("bridge：状态文件变更时向本进程订阅推送 session.upserted（跨进程实时传播）", async () => {
	// 命令侧（另一进程）只写状态文件；持有 sessions-index 订阅的本进程必须在
	// 文件变化的下一个监听跳（默认 3s）把新会话推给订阅方——host 握手稳定后
	// 不再周期 resync，没有这一环侧栏就永远等不到新会话。
	const stateDir = mkdtempSync(join(tmpdir(), "stepbridge-watch-"));
	const workspace = "C:/tmp/watch-suite";
	const bridgeIndex = launchBridge([], {}, { stateDir });
	try {
		const topic = `sessions-index/${workspace}`;
		bridgeIndex.send({
			id: 1,
			method: "v4/conversation/subscribe",
			params: { topic, connectionId: "conn-watch", clientMode: "desktop-continuous" },
		});
		await bridgeIndex.waitFor((f) => f.id === 1, { label: "v4 subscribe" });
		// 空基线快照（markSummariesSeen 起点水位）。
		await bridgeIndex.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params?.topic === topic && f.params.frame.payload.kind === "snapshot",
			{ label: "空基线快照" },
		);
		// 另一“进程”直接写状态文件（模拟命令侧桥接的 persistSessionSummary 原子写）。
		const { renameSync, mkdirSync: mkdir, writeFileSync: writeFile } = await import("node:fs");
		const file = join(stateDir, "sessions-index.json");
		mkdir(stateDir, { recursive: true });
		writeFile(`${file}.writer.tmp`, JSON.stringify({
			version: 1,
			workspaces: {
				[workspace.replaceAll("/", "\\").toLowerCase()]: [{
					sessionId: "step-session_watch_1",
					workspaceId: workspace,
					title: "watch test",
					phase: "completedSuccess",
					sessionEnded: false,
					hasBackgroundWork: false,
					lastActivityAt: 123,
					createdAt: 123,
				}],
			},
		}), "utf8");
		renameSync(`${file}.writer.tmp`, file);
		const pushed = await bridgeIndex.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params?.topic === topic
				&& f.params.frame.payload.kind === "deltas"
				&& f.params.frame.payload.deltas?.some((d) => d.op === "session.upserted" && d.session.sessionId === "step-session_watch_1"),
			{ timeoutMs: 15000, label: "跨进程推送 upsert" },
		);
		assert.ok(pushed);
		bridgeIndex.child.stdin.end();
		const { code: exitCode } = await waitForExit(bridgeIndex.child, { label: "bridgeIndex EOF 优雅退出（跨进程推送）" });
		assert.equal(exitCode, 0);
	} finally {
		if (bridgeIndex.child.exitCode === null) bridgeIndex.child.kill();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("bridge：跨进程读取已完成会话正文", async () => {
 const stateDir=mkdtempSync(join(tmpdir(),'stepbridge-history-'));
 const a=launchBridge([], {}, {stateDir});
 let b;
 try {
  a.send({id:1,method:'session/create',params:{sessionId:'saved-history',workspace:{workspacePath:'C:/tmp/history'}}});
  await a.waitFor(f=>f.id===1);
  a.send({id:2,method:'v4/conversation/subscribe',params:{topic:'conversation/saved-history',connectionId:'a',clientMode:'desktop-continuous'}});
  await a.waitFor(f=>f.id===2);
  a.send({id:3,method:'v4/command',params:{commandId:'history-send',type:'sendText',sessionId:'saved-history',payload:{text:'history verification'}}});
  await a.waitFor(f=>f.params?.frame?.payload?.snapshot?.rows?.window?.some(r=>r.kind==='assistantText'));
  b=launchBridge([], {}, {stateDir});
  b.send({id:1,method:'session/read',params:{sessionId:'saved-history'}});
  assert.equal((await b.waitFor(f=>f.id===1)).result.session.sessionId,'saved-history');
  b.send({id:2,method:'v4/conversation/subscribe',params:{topic:'conversation/saved-history',connectionId:'b',clientMode:'desktop-continuous'}});
  const frame=await b.waitFor(f=>f.params?.frame?.payload?.snapshot?.rows?.window?.some(r=>r.kind==='assistantText'));
  assert.ok(frame.params.frame.payload.snapshot.rows.window.some(r=>r.text==='history verification'));
 // R6 清理：kill 后等桥进程退出再删状态目录（同 zcode-bridge-attachments.mjs）。
 } finally { a.child.kill(); b?.child.kill();
  await waitForExit(a.child,{label:'bridgeA 退出（历史正文状态目录清理）'});
  if(b)await waitForExit(b.child,{label:'bridgeB 退出（历史正文状态目录清理）'});
  try{rmSync(stateDir,{recursive:true,force:true});}catch{/* Windows 句柄延迟释放时忽略；临时目录由系统清理。 */}
 }
});
