import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelConfigSignatures } from "../src/model-config-signatures.mjs";
import { testProviderConnectivity, connectivityProbeOptions } from "../src/bridge/provider-connectivity.mjs";
import { createClientRuntime } from "../src/bridge/client-runtime.mjs";
import { createSessionMethods } from "../src/bridge/methods-session.mjs";
import { createSessionLifecycle } from "../src/bridge/session-lifecycle.mjs";
import { createManagedQueue } from "../src/bridge/managed-queue.mjs";
import { InputLedger } from "../src/input-admission.mjs";
import { pluginConfigSignature } from "../src/official-plugins.mjs";

const mockCommand = [process.execPath, fileURLToPath(new URL("../mock/step-rpc-mock.mjs", import.meta.url))];
const selection = { providerId: "mock", modelId: "mock-mini" };

test("基础文本探测选项只来自本次模型 snapshot：关闭/已知低档优先，其余使用声明默认", () => {
  const model = values => ({ compat: { stepcodeDesktop: { optionSpecs: { reasoningLevel: { values } } } } });
  assert.deepEqual(connectivityProbeOptions(model(["enabled", "disabled"])), { reasoningLevel: "disabled" });
  assert.deepEqual(connectivityProbeOptions(model(["high", "low"])), { reasoningLevel: "low" });
  assert.deepEqual(connectivityProbeOptions(model(["vendor-fast", "vendor-careful"])), { reasoningLevel: "vendor-fast" });
  assert.equal(connectivityProbeOptions({}), undefined);
});

async function pluginRefreshFixture(t) {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "plugin-refresh-"));
  const ctx = {
    options: { stepModelsFile: join(root, "models.json"), communicationMode: "mock" }, STATE_DIR: root,
    spawnCommand: mockCommand, turnBusy: false, projectStepEvent() {},
    primarySession: { sessionId: "refresh", workspace: { workspacePath: root }, modelSelection: selection },
    conversationRows: [{ kind: "assistantText", text: "保留历史投影" }],
    ledger: new InputLedger(), attachmentStore: { prepare: async (_id, _attachments, text) => ({ images: [], text }) },
    hydrateStatistics: async () => {}, persistConversation() {}, persistPrimarySummary() {},
    broadcastConversationSnapshot() {}, broadcastSessionsIndexUpsert() {}, nextRowId: () => "row",
  };
  Object.assign(ctx, createClientRuntime(ctx), createSessionLifecycle(ctx), createManagedQueue(ctx));
  t.after(async () => { await ctx.client?.stop(); await ctx.embeddedBrowserRelay?.close(); await rm(root, { recursive: true, force: true }); });
  await ctx.ensureClient();
  await ctx.client.setModel("mock", "mock-mini");
  await ctx.client.setThinkingLevel("high");
  await ctx.client.request({ type: "set_session_name", name: "保留标题" });
  const original = ctx.client, rows = ctx.conversationRows, signature = ctx.pluginSignature;
  await mkdir(join(root, "plugins", "fixture"), { recursive: true });
  await writeFile(join(root, "plugins", "fixture", "step.plugin.json"), '{"name":"fixture"}');
  assert.notEqual(await pluginConfigSignature(root), signature);
  return { ctx, original, rows, signature };
}

for (const explicit of [false, true]) {
  test(`插件变化：同模型${explicit ? "显式选择" : "无选择"}续发先刷新，保留标题模型档位和历史投影`, async t => {
    const { ctx, original, rows } = await pluginRefreshFixture(t);
    const requests = [];
    // 使用真实 RPC mock，同时核对恢复指令的原会话路径；mock 本身不持久化历史。
    const oldState = await original.getState();
    const { StepCodeRpcClient } = await import("../src/rpc-client.mjs");
    const request = StepCodeRpcClient.prototype.request;
    t.mock.method(StepCodeRpcClient.prototype, "request", function (command, ...args) {
      requests.push(command); return request.call(this, command, ...args);
    });
    await ctx.admitAndSend({ commandId: "refresh-send", text: "继续", ...(explicit ? { modelSelection: selection } : {}) });
    assert.notEqual(ctx.client, original, "插件变化后的同模型发送必须更换底座进程");
    assert.ok(requests.some(command => command.type === "switch_session" && command.sessionPath === oldState.sessionFile));
    const state = await ctx.client.getState();
    assert.equal(state.sessionName, "保留标题");
    assert.equal(state.model.id, "mock-mini");
    assert.equal(state.thinkingLevel, "high");
    assert.equal(ctx.conversationRows, rows);
    assert.ok(requests.findIndex(command => command.type === "switch_session") < requests.findIndex(command => command.type === "prompt"));
  });
}

for (const delivery of ["queue", "startNow"]) {
  test(`插件变化：busy ${delivery} 不刷新且保持准入语义，空闲后刷新`, async t => {
    const { ctx, original, signature } = await pluginRefreshFixture(t);
    ctx.turnBusy = true;
    const settled = delivery === "startNow" ? original.waitForIdle(3000) : Promise.resolve();
    const entry = await ctx.admitAndSend({ commandId: "busy-send", text: "跟进", requestedDelivery: delivery });
    assert.equal(ctx.client, original);
    assert.equal(ctx.pluginSignature, signature);
    assert.equal(entry.decision.route, delivery === "queue" ? "followUp" : "steer");
    await settled;
    ctx.turnBusy = false;
    if (delivery === "queue") {
      ctx.scheduleQueueDrain();
      await ctx.runInputOperation(async () => {});
    } else await ctx.ensureClient();
    assert.notEqual(ctx.client, original);
  });
}

test("插件变化：底座 streaming 或待回答交互保护刷新，解除后只重启一次", async t => {
  const { ctx, original, signature } = await pluginRefreshFixture(t);
  const getState = original.getState.bind(original);
  const streaming = t.mock.method(original, "getState", async () => ({ ...(await getState()), isStreaming: true }));
  await ctx.ensureClient();
  assert.equal(ctx.client, original);
  streaming.mock.restore();
  const answer = ctx.workflowBridge.permission("refresh", { id: "pending-refresh", method: "input", title: "等待答案" });
  await ctx.ensureClient();
  assert.equal(ctx.client, original);
  assert.equal(ctx.pluginSignature, signature);
  ctx.workflowBridge.cancelPending("refresh");
  await answer;
  const { StepCodeRpcClient } = await import("../src/rpc-client.mjs");
  const start = t.mock.method(StepCodeRpcClient.prototype, "start");
  await Promise.all([ctx.ensureClient(), ctx.ensureClient()]);
  const refreshed = ctx.client;
  assert.notEqual(refreshed, original);
  await ctx.ensureClient();
  assert.equal(ctx.client, refreshed, "未变化的签名不能反复重启");
  assert.equal(start.mock.callCount(), 1);
});

for (const failure of ["history", "title"]) test(`插件变化：恢复${failure}失败后本次和后续发送均被阻止`, async t => {
  const { ctx, rows } = await pluginRefreshFixture(t);
  const { StepCodeRpcClient } = await import("../src/rpc-client.mjs");
  const request = StepCodeRpcClient.prototype.request;
  let prompts = 0;
  t.mock.method(StepCodeRpcClient.prototype, "request", function (command, ...args) {
    if (failure === "history" && command.type === "switch_session") return Promise.resolve({ success: true, data: { cancelled: true } });
    if (failure === "title" && command.type === "set_session_name") return Promise.resolve({ success: false });
    if (command.type === "prompt") prompts++;
    return request.call(this, command, ...args);
  });
  for (const commandId of ["failed-restore-1", "failed-restore-2"])
    await assert.rejects(ctx.admitAndSend({ commandId, text: "不能丢历史" }), /恢复会话.*失败/);
  assert.equal(prompts, 0);
  assert.equal(ctx.turnBusy, false);
  assert.equal(ctx.conversationRows, rows);
});

test("同一模型图片能力更新：闲时刷新 SDK 并恢复历史", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-capabilities-"));
  const file = join(root, "models.json");
  const document = input => ({providers:{mock:{api:"openai-completions",baseUrl:"https://example.com/v1",apiKey:"fixture-key",models:[{id:"mock-mini",input}]}}});
  await writeFile(file, JSON.stringify(document(["text"])));
  const signatures = await readModelConfigSignatures(file);
  await writeFile(file, JSON.stringify(document(["text","image"])));
  let stopped = false;
  const previous = {getAvailableModels:async()=>[{provider:"mock",id:"mock-mini"}],getState:async()=>({isStreaming:false,sessionFile:"/mock/existing.jsonl",sessionName:"图片会话"}),stop:async()=>{stopped=true;}};
  const ctx = {options:{stepModelsFile:file,communicationMode:"mock"},STATE_DIR:root,spawnCommand:mockCommand,client:previous,clientStartPromise:Promise.resolve(),modelConfigSignatures:signatures,turnBusy:false,projectStepEvent(){}};
  try {await createClientRuntime(ctx).setClientModel("mock","mock-mini");assert.equal(stopped,true);assert.equal((await ctx.client.getState()).sessionName,"图片会话");}
  finally {await ctx.client?.stop();await rm(root,{recursive:true,force:true});}
});

test("自定义供应商：设置页测试使用独立真实 RPC 客户端，不修改聊天状态", async () => {
	const active = { sentinel: true };
	const ctx = { spawnCommand: mockCommand, options: { communicationMode: "mock" }, client: active, primarySession: { sessionId: "keep" } };
	assert.deepEqual(await createSessionMethods(ctx)["provider/testModelConnectivity"]({ selection }), { success: true });
	assert.equal(ctx.client, active);
	assert.equal(ctx.primarySession.sessionId, "keep");
	await assert.rejects(testProviderConnectivity(ctx, { selection: { ...selection, modelId: "missing" } }), /Model not found/);
});

for (const failure of ["empty", "error", "wrong-model", "admission"]) {
	test(`自定义供应商：测试 ${failure} 必须失败且清理临时进程`, async () => {
		let handler, stopped = false, unsubscribed = false;
		const client = {
			start: async () => {}, setModel: async () => {},
			onEvent: callback => { handler = callback; return () => { unsubscribed = true; }; },
			prompt: async () => {
				if (failure === "admission") throw Error("admission failed");
				if (failure === "error") handler({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
				handler({ type: "agent_settled" });
			},
			getState: async () => ({ model: { provider: "mock", id: failure === "wrong-model" ? "wrong" : "mock-mini" } }),
			getLastAssistantText: async () => failure === "empty" ? "" : "OK",
			stop: async () => { stopped = true; },
		};
		await assert.rejects(testProviderConnectivity({ spawnCommand: mockCommand, options: {} }, { selection }, () => client));
		assert.equal(stopped, true);
		assert.equal(unsubscribed, true);
	});
}

test("自定义供应商：测试 ACK 后进程失败立即拒绝并清理事件/lifecycle 订阅", async () => {
  let failure, stopped = false, eventRemoved = false, failureRemoved = false;
  const client = {
    start: async () => {}, setModel: async () => {},
    onEvent: () => () => { eventRemoved = true; },
    onFailure: callback => { failure = callback; return () => { failureRemoved = true; }; },
    prompt: async () => { failure(Error("step process exited (code=130)")); },
    stop: async () => { stopped = true; },
  };
  await assert.rejects(testProviderConnectivity({ spawnCommand: mockCommand, options: {} }, { selection }, () => client), /process exited/);
  assert.equal(stopped, true); assert.equal(eventRemoved, true); assert.equal(failureRemoved, true);
});

test("自定义供应商：旧 SDK 缺少新增模型时刷新，恢复原历史和标题", async () => {
	let stopped = false;
	const previous = {
		getAvailableModels: async () => [],
		getState: async () => ({ isStreaming: false, sessionFile: "/mock/existing.jsonl", sessionName: "原会话" }),
		stop: async () => { stopped = true; },
	};
	const ctx = { options: { communicationMode: "mock" }, STATE_DIR: ".", spawnCommand: mockCommand, client: previous, clientStartPromise: Promise.resolve(), turnBusy: false, projectStepEvent() {} };
	const runtime = createClientRuntime(ctx);
	try {
		await runtime.setClientModel("mock", "mock-mini");
		assert.equal(stopped, true);
		assert.notEqual(ctx.client, previous);
		const state = await ctx.client.getState();
		assert.equal(state.model.id, "mock-mini");
		// mock 的 switch_session 不读取真实历史，而是生成恢复标识；精确路径另由真实 SDK 验收。
		assert.match(state.sessionFile, /^mock:\/\/sessions\/mock-session-/);
		assert.equal(state.sessionName, "原会话");
	} finally { await ctx.client.stop(); }
});

for (const turnBusy of [true, false]) {
	test(`自定义供应商：${turnBusy ? "桥接忙碌" : "底层 streaming"}时拒绝刷新`, async () => {
		let stopped = false;
		const client = { getAvailableModels: async () => [], getState: async () => ({ isStreaming: !turnBusy }), stop: async () => { stopped = true; } };
		const ctx = { options: { communicationMode: "mock" }, STATE_DIR: ".", spawnCommand: mockCommand, client, clientStartPromise: Promise.resolve(), turnBusy };
		await assert.rejects(createClientRuntime(ctx).setClientModel("mock", "mock-mini"), /正在运行|仍在运行/);
		assert.equal(stopped, false);
		assert.equal(ctx.client, client);
	});
}
