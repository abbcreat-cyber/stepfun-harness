/**
 * zcode-bridge 套件（订阅与 topic 恢复）：非会话 topic 初始帧、冷订阅历史 topic、
 * 多连接隔离与 same-subscription recovery。
 * 从 zcode-bridge.mjs 机械拆分，用例逐字保留。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBridge } from "./zcode-bridge-launch.mjs";
import { waitForExit } from "./helpers.mjs";

test("bridge：sessions-index / workspace-config 订阅回初始帧", async () => {
	const bridge = launchBridge();
	try {
		bridge.send({
			id: 1,
			method: "session/create",
			params: { workspace: { workspacePath: "C:/tmp/suite2" } },
		});
		await bridge.waitFor((f) => f.id === 1, { label: "session/create" });

		bridge.send({ id: 2, method: "v4/conversation/subscribe", params: { topic: "sessions-index/ws-1", connectionId: "conn-2", clientMode: "desktop-continuous" } });
		const ack = await bridge.waitFor((f) => f.id === 2, { label: "sessions-index ack" });
		assert.equal(ack.result.ack.mode, "snapshot");
		const indexFrame = await bridge.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params.topic === "sessions-index/ws-1",
			{ label: "sessions-index 初始帧" },
		);
		assert.equal(indexFrame.params.kind, "complete");
		assert.equal(indexFrame.params.deliveryKind, "initial");
		assert.equal(indexFrame.params.frame.payload.kind, "snapshot");
		assert.equal(Array.isArray(indexFrame.params.frame.payload.snapshot.sessions), true);

		bridge.send({ id: 3, method: "v4/conversation/subscribe", params: { topic: "workspace-config/ws-1", connectionId: "conn-3", clientMode: "desktop-continuous" } });
		await bridge.waitFor((f) => f.id === 3, { label: "workspace-config ack" });
		const configFrame = await bridge.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params.topic === "workspace-config/ws-1",
			{ label: "workspace-config 初始帧" },
		);
		assert.deepEqual(configFrame.params.frame.payload.snapshot.config.configOptions, []);
        assert.equal(configFrame.params.frame.payload.snapshot.config.slashCommands[0].name, "workflow");

		bridge.child.stdin.end();
		const { code: exitCode } = await waitForExit(bridge.child, { label: "bridge EOF 优雅退出（sessions-index/workspace-config 初始帧）" });
		assert.equal(exitCode, 0);
	} finally {
		if (bridge.child.exitCode === null) bridge.child.kill();
	}
});

test("bridge：冷订阅历史 topic 无 primarySession 时 subscribe/resync 均回帧（recoveryFrameTimedOut 回归）", async () => {
	// 线上事件：应用重启后 UI 恢复上次会话，冷订阅 bridge 未知的历史 sessionId；桥若在
	// ack 后不回帧，壳的 v4 恢复握手超时即弹 fault.subscription.recoveryFrameTimedOut。
	const bridge = launchBridge();
	try {
		const topic = "conversation/step-session_cold_historic";
		bridge.send({
			id: 1,
			method: "v4/conversation/subscribe",
			params: { topic, connectionId: "conn-cold", clientMode: "desktop-continuous" },
		});
		const ack = await bridge.waitFor((f) => f.id === 1, { label: "v4 subscribe" });
		assert.equal(ack.result.ack.mode, "snapshot");
		// 未 session/create（无 primarySession）也必须在 ack 后于该 topic 回初始帧。
		const initial = await bridge.waitFor(
			(f) => f.method === "v4/conversation/frame" && f.params?.topic === topic,
			{ label: "冷订阅初始帧" },
		);
		assert.equal(initial.params.frame.payload.kind, "snapshot");
		assert.equal(initial.params.frame.payload.snapshot.sessionId, topic.slice("conversation/".length));
		assert.equal(initial.params.frame.payload.snapshot.rows.totalCount, 0);
		assert.equal(initial.params.frame.payload.snapshot.rows.window.length, 0);

		bridge.send({
			id: 2,
			method: "v4/conversation/resync",
			params: { topic, subscriptionId: ack.result.ack.subscriptionId, base: null, forceSnapshot: true },
		});
		const resyncAck = await bridge.waitFor((f) => f.id === 2, { label: "v4 resync ack" });
		assert.equal(resyncAck.result.ack.mode, "snapshot");
		// resync 的帧必须落在被 resync 的 topic 上（而非当前 primary 会话），且 toSeq 严格递增。
		const resyncFrame = await bridge.waitFor(
			(f) =>
				f.method === "v4/conversation/frame" &&
				f.params?.topic === topic &&
				f.params.frame.payload.kind === "snapshot" &&
				f.params.frame.toSeq > initial.params.frame.toSeq,
			{ label: "resync 帧" },
		);
		assert.equal(resyncFrame.params.frame.payload.snapshot.sessionId, topic.slice("conversation/".length));
		assert.equal(resyncFrame.params.frame.payload.snapshot.rows.totalCount, 0);
		assert.equal(resyncFrame.params.deliveryKind, "recovery");
		assert.ok(bridge.frames.indexOf(resyncAck) < bridge.frames.indexOf(resyncFrame));
		assert.ok(bridge.frames.indexOf(ack) < bridge.frames.indexOf(initial));

		bridge.child.stdin.end();
		const { code: exitCode } = await waitForExit(bridge.child, { label: "bridge EOF 优雅退出（冷订阅历史 topic）" });
		assert.equal(exitCode, 0);
	} finally {
		if (bridge.child.exitCode === null) bridge.child.kill();
	}
});

test("bridge：多连接隔离与 same-sub recovery（desktop / mobile）", async () => {
 const bridge = launchBridge();
 try {
  const topic = 'conversation/owned-test';
  for (const [id, connectionId, clientMode] of [[1,'desktop','desktop-continuous'],[2,'mobile','web-remote-replayable']]) {
   bridge.send({id,method:'v4/conversation/subscribe',params:{topic,connectionId,clientMode}});
   await bridge.waitFor(f=>f.id===id);
  }
  const first=bridge.frames.find(f=>f.id===1).result.ack.subscriptionId;
  const second=bridge.frames.find(f=>f.id===2).result.ack.subscriptionId;
  bridge.send({id:3,method:'v4/conversation/resync',params:{topic,connectionId:'desktop',subscriptionId:first,base:null,forceSnapshot:true}});
  const ack=await bridge.waitFor(f=>f.id===3);
  assert.equal(ack.result.ack.subscriptionId, first);
  const recovered=await bridge.waitFor(f=>f.params?.deliveryKind==='recovery');
  assert.equal(recovered.params.subscriptionId,first);
  assert.ok(bridge.frames.indexOf(ack)<bridge.frames.indexOf(recovered));
  bridge.send({id:4,method:'v4/conversation/resync',params:{topic,connectionId:'desktop',subscriptionId:second,base:null}});
  assert.match((await bridge.waitFor(f=>f.id===4)).error.message,/notOwned/);
 } finally { bridge.child.kill(); }
});
