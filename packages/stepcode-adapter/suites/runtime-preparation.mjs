import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createClientRuntime } from "../src/bridge/client-runtime.mjs";
import { createSessionLifecycle } from "../src/bridge/session-lifecycle.mjs";
import { createManagedQueue } from "../src/bridge/managed-queue.mjs";
import { readModelConfigSignatures } from "../src/model-config-signatures.mjs";
import { InputLedger } from "../src/input-admission.mjs";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { classifyStepSendFault } from "../src/step-send-errors.mjs";
import { createSessionAdmin } from "../src/bridge/session-admin.mjs";
import { createSessionMethods } from "../src/bridge/methods-session.mjs";
import { createStepWorkflowDriver } from "../src/workflow/step-driver.mjs";

const selection = { providerId: "mock", modelId: "mock-mini" };
const alternate = { providerId: "step", modelId: "step-5-preview" };
const document = patch => ({ providers: { mock: { api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "fixture-a", models: [{ id: "mock-mini", input: ["text"] }], ...patch } } });

async function fixture(t) {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "runtime-"));
  const file = join(root, "models.json");
  await writeFile(file, JSON.stringify(document()));
  const ctx = {
    options: { stepModelsFile: file, communicationMode: "mock", stepEnv: { USERPROFILE: root } }, STATE_DIR: root,
    spawnCommand: [process.execPath, fileURLToPath(new URL("../mock/step-rpc-mock.mjs", import.meta.url))],
    turnBusy: false, projectStepEvent() {}, primarySession: { sessionId: "runtime", workspace: { workspacePath: root }, modelSelection: selection },
    conversationRows: [{ kind: "assistantText", text: "history" }], ledger: new InputLedger(),
    attachmentStore: { prepare: async (_id, _attachments, text) => ({ images: [], text }) }, hydrateStatistics: async () => {}, persistConversation() {}, persistPrimarySummary() {},
    broadcastConversationSnapshot() {}, broadcastSessionsIndexUpsert() {}, nextRowId: () => "row",
  };
  Object.assign(ctx, createClientRuntime(ctx), createSessionLifecycle(ctx), createManagedQueue(ctx));
  t.after(async () => { await ctx.disposeTestActors?.(); await ctx.client?.stop(); await ctx.embeddedBrowserRelay?.close(); await rm(root, { recursive: true, force: true }); });
  await ctx.ensureClient(); await ctx.client.setModel("mock", "mock-mini");
  await ctx.client.setThinkingLevel("high");
  await ctx.client.request({ type: "set_session_name", name: "preserved" });
  return { ctx, file };
}

test('prepared: newly installed rule reloads next idle client and retains history/title/model',async t=>{
  const {ctx}=await fixture(t),original=ctx.client,rows=ctx.conversationRows;
  const directory=join(original.options.env.STEP_CODING_AGENT_DIR,'extensions');
  await mkdir(directory,{recursive:true});await writeFile(join(directory,'fresh-rule.mjs'),'export default function rule() {}');
  await ctx.runWithPreparedClient({selection,requireIdle:true},async client=>{
    assert.notEqual(client,original);const state=await client.getState();
    assert.equal(state.sessionName,'preserved');assert.equal(state.model.id,selection.modelId);
  });
  assert.equal(ctx.conversationRows,rows);
});

for (const explicit of [false, true]) for (const field of ["apiKey", "baseUrl", "headers", "models", "compat"]) {
  test(`prepared: ordinary ${explicit ? "explicit" : "implicit"} same-model send refreshes ${field}`, async t => {
    const { ctx, file } = await fixture(t), original = ctx.client, rows = ctx.conversationRows;
    const patch = { apiKey: "fixture-b", baseUrl: "https://other.invalid/v1", headers: { "x-fixture": "changed" }, models: [{ id: "mock-mini", input: ["text", "image"], contextWindow: 2048 }], compat: { fixture: true } };
    await writeFile(file, JSON.stringify(document({ [field]: patch[field] })));
    await ctx.admitAndSend({ commandId: "same", text: "hello", ...(explicit ? { modelSelection: selection } : {}) });
    assert.notEqual(ctx.client, original);
    assert.equal(ctx.modelConfigSignatures.get("mock\0mock-mini"), (await readModelConfigSignatures(file, ctx.options.stepEnv)).get("mock\0mock-mini"));
    const state = await ctx.client.getState();
    assert.equal(state.sessionName, "preserved"); assert.equal(state.thinkingLevel, "high"); assert.equal(state.model.id, "mock-mini");
    assert.equal(ctx.conversationRows, rows);
  });
}

test("prepared: concurrent selections share one complete transaction", async t => {
  const { ctx, file } = await fixture(t), original = ctx.client;
  await writeFile(file, JSON.stringify(document({ apiKey: "fixture-b" })));
  t.mock.method(original, "getAvailableModels", async () => []);
  const starts = t.mock.method(StepCodeRpcClient.prototype, "start");
  const results = await Promise.all([ctx.setClientModel(selection.providerId, selection.modelId), ctx.setClientModel(alternate.providerId, alternate.modelId)]);
  assert.deepEqual(results.map(model => model.id), [selection.modelId, alternate.modelId]);
  assert.equal(starts.mock.callCount(), 1);
});

for (const busy of ["turn", "stream", "interaction"]) test(`prepared: ${busy} rejects registered model and thought mutation`, async t => {
  const { ctx } = await fixture(t), original = ctx.client;
  if (busy === "turn") ctx.turnBusy = true;
  if (busy === "stream") { const state = await original.getState(); t.mock.method(original, "getState", async () => ({ ...state, isStreaming: true })); }
  const waiting = busy === "interaction" ? ctx.workflowBridge.permission("runtime", { id: "pending", method: "input" }) : null;
  await assert.rejects(ctx.setClientModel(alternate.providerId, alternate.modelId), /仍在运行|正在运行/);
  await assert.rejects(ctx.applyThoughtLevel("low"), /仍在运行|正在运行/);
  assert.equal(ctx.client, original);
  if (waiting) { ctx.workflowBridge.cancelPending("runtime"); await waiting; }
});

test("prepared: deletion rejects plain send; valid explicit selection retains history and recovers", async t => {
  const { ctx, file } = await fixture(t), rows = ctx.conversationRows;
  await writeFile(file, JSON.stringify({ providers: {} }));
  await assert.rejects(ctx.admitAndSend({ commandId: "deleted", text: "no" }), /Model not found|已删除|不可用/);
  assert.equal(ctx.turnBusy, false);
  await ctx.admitAndSend({ commandId: "valid", text: "yes", modelSelection: alternate, modelSelectionExplicit: true });
  assert.equal((await ctx.client.getState()).model.id, alternate.modelId);
  assert.equal(ctx.primarySession.modelSelection.modelId, alternate.modelId); assert.equal(ctx.conversationRows, rows);
});

test("prepared: SDK credential environment changes restart at next idle operation", async t => {
  const { ctx } = await fixture(t), original = ctx.client;
  ctx.options.stepEnv.STEP_API_KEY = "fixture-env-b";
  await ctx.admitAndSend({ commandId: "env", text: "hello" });
  assert.notEqual(ctx.client, original);
  assert.equal((await ctx.client.getState()).sessionName, "preserved");
});

test("prepared: normalized config root change restarts even when model contents match", async t => {
  const { ctx } = await fixture(t), original = ctx.client;
  ctx.options.stepEnv.STEPCODE_CONFIG_DIR = join(ctx.STATE_DIR, "alternate-root");
  await ctx.ensureClient();
  assert.notEqual(ctx.client, original);
  assert.equal(ctx.client.options.env.STEP_CODING_AGENT_DIR, join(ctx.STATE_DIR, "alternate-root", "agent"));
  assert.equal((await ctx.client.getState()).sessionName, "preserved");
});

test("prepared: busy same-model change defers refresh until queue executes", async t => {
  const { ctx, file } = await fixture(t), original = ctx.client;
  ctx.turnBusy = true; await writeFile(file, JSON.stringify(document({ apiKey: "fixture-b" })));
  const entry = await ctx.admitAndSend({ commandId: "deferred", text: "hello", modelSelection: selection });
  assert.equal(entry.state, "queued"); assert.equal(ctx.client, original);
  ctx.turnBusy = false; ctx.scheduleQueueDrain(); await ctx.runInputOperation(async () => {});
  assert.notEqual(ctx.client, original);
});

test("prepared: direct and queued prompt stage original UI options immediately before delivery; busy steer never stages", async t => {
  const { ctx } = await fixture(t), calls = [];
  const prepare = ctx.preparePrompt, prompt = ctx.client.prompt;
  t.mock.method(ctx, "preparePrompt", async (client, chosen, requestId) => {
    calls.push({ stage: "prepare", requestId, options: structuredClone(chosen.options) });
    return prepare(client, chosen, requestId);
  });
  t.mock.method(ctx.client, "prompt", async function (...args) { calls.push({ stage: "prompt" }); return prompt.apply(this, args); });
  const chosen = { ...selection, options: { reasoningLevel: "enabled" } };
  await ctx.admitAndSend({ commandId: "direct", text: "hello", modelSelection: chosen });
  assert.deepEqual(calls.slice(0, 2), [{ stage: "prepare", requestId: "direct", options: chosen.options }, { stage: "prompt" }]);
  ctx.turnBusy = true;
  await ctx.admitAndSend({ commandId: "queue-options", text: "queued", modelSelection: chosen });
  assert.equal(calls.filter(call => call.stage === "prepare").length, 1);
  const settled = ctx.client.waitForIdle(3000);
  await ctx.admitAndSend({ commandId: "steer-options", text: "steer", modelSelection: chosen, requestedDelivery: "startNow" });
  assert.equal(calls.filter(call => call.stage === "prepare").length, 1);
  await settled;
  ctx.turnBusy = false; ctx.scheduleQueueDrain(); await ctx.runInputOperation(async () => {});
  assert.deepEqual(calls.filter(call => call.stage === "prepare").at(-1), { stage: "prepare", requestId: "queue-options", options: chosen.options });
});

test("prepared: known prompt rejection discards the staged request and accepts a corrected next send", async t => {
  const { ctx } = await fixture(t), discarded = [];
  const discard = ctx.discardPreparedPrompt, prompt = ctx.client.prompt;
  let reject = true;
  t.mock.method(ctx, "discardPreparedPrompt", async (client, chosen, id) => { discarded.push(id); return discard(client, chosen, id); });
  t.mock.method(ctx.client, "prompt", async function (...args) {
    if (reject) { reject = false; throw Object.assign(Error("401 fixture"), { stepRejected: true }); }
    return prompt.apply(this, args);
  });
  await assert.rejects(ctx.admitAndSend({ commandId: "reject", text: "first" }), /401 fixture/);
  assert.equal(ctx.turnBusy, false); assert.deepEqual(discarded, ["reject"]);
  await ctx.admitAndSend({ commandId: "corrected", text: "second" });
  assert.equal(ctx.ledger.entries.get("corrected").state, "submitted");
});

test("prepared: workflow completion busy→idle uses managed queue and prepares the next run", async t => {
  const { ctx } = await fixture(t), prompts = [], prepared = [];
  ctx.primarySession.modelSelection = { ...selection, options: { reasoningLevel: "enabled" } };
  ctx.turnBusy = true;
  t.mock.method(ctx, "preparePrompt", async (_client, chosen, id) => { prepared.push({ chosen, id }); });
  t.mock.method(ctx.client, "prompt", async (_text, options) => {
    if (!prepared.length) throw Error("Mapped options were not prepared for the new run");
    prompts.push(options);
  });
  const entry = await ctx.notifyWorkflowCompletion("runtime", { runId: "workflow", status: "completed" });
  assert.equal(entry.kind, "sendText"); assert.equal(entry.clientId, "stepcode-workflow"); assert.equal(entry.state, "queued");
  const { conversationInputIntentSchema } = await import("@zcode/shared/zcode-protocol-v4");
  assert.doesNotThrow(() => conversationInputIntentSchema.parse(ctx.ledger.queueItems()[0]));
  assert.equal(prompts.length, 0);
  ctx.turnBusy = false; ctx.scheduleQueueDrain(); await ctx.runInputOperation(async () => {});
  assert.equal(prompts.length, 1); assert.equal(prompts[0].streamingBehavior, undefined);
  assert.equal(prepared[0].chosen.options.reasoningLevel, "enabled");
});

test("prepared: mapped busy startNow that reaches an idle SDK carries current options before the native prompt", async t => {
  const { ctx } = await fixture(t), state = await ctx.client.getState();
  const mappedModel = { ...state.model, compat: { stepcodeDesktop: { optionSpecs: { reasoningLevel: { values: ["enabled"], map: '{"wire_reasoning": reasoningLevel}' } } } } };
  ctx.primarySession.modelSelection = { ...selection, options: { reasoningLevel: "enabled" } };
  ctx.turnBusy = true;
  t.mock.method(ctx.client, "getState", async () => ({ ...state, model: mappedModel, isStreaming: false }));
  const prepared = []; let delivered = 0;
  t.mock.method(ctx, "preparePrompt", async (_client, chosen) => prepared.push(chosen.options));
  t.mock.method(ctx, "carryPrompt", async (_client, chosen) => prepared.push(chosen.options));
  t.mock.method(ctx.client, "prompt", async () => {
    if (!prepared.length) throw Error("Mapped options were not prepared for the new run");
    delivered++;
  });
  const entry = await ctx.admitAndSend({ commandId: "mapped-race", text: "race", requestedDelivery: "startNow" });
  assert.equal(entry.state, "steered"); assert.equal(entry.decision.route, "steer");
  assert.equal(delivered, 1); assert.deepEqual(prepared, [{ reasoningLevel: "enabled" }]);
});

test("prepared: truly busy continuous same-option steering carries without mutating current options", async t => {
  const { ctx } = await fixture(t), carried = [], messages = [];
  ctx.primarySession.modelSelection = { ...selection, options: { reasoningLevel: "enabled" } }; ctx.turnBusy = true;
  t.mock.method(ctx, "preparePrompt", async () => { throw Error("busy must not prepare a new selection"); });
  t.mock.method(ctx, "carryPrompt", async (_client, chosen, id) => carried.push({ chosen: structuredClone(chosen), id }));
  t.mock.method(ctx.client, "prompt", async (text, options) => messages.push({ text, options }));
  await ctx.admitAndSend({ commandId: "steer-1", text: "first", requestedDelivery: "startNow" });
  await ctx.admitAndSend({ commandId: "steer-2", text: "second", requestedDelivery: "startNow" });
  assert.deepEqual(carried.map(item => item.id), ["steer-1", "steer-2"]);
  assert.ok(carried.every(item => item.chosen.options.reasoningLevel === "enabled"));
  assert.deepEqual(messages.map(item => item.options.streamingBehavior), ["steer", "steer"]);
  assert.equal(ctx.primarySession.modelSelection.options.reasoningLevel, "enabled");
});

test("prepared: busy new options wait in the existing managed queue with an explicit fallback", async t => {
  const { ctx } = await fixture(t); ctx.primarySession.modelSelection = { ...selection, options: { reasoningLevel: "enabled" } }; ctx.turnBusy = true;
  t.mock.method(ctx, "carryPrompt", async () => { throw Error("cannot carry new options into the active turn"); });
  const entry = await ctx.admitAndSend({ commandId: "new-options", text: "later", requestedDelivery: "startNow", modelSelection: { ...selection, options: { reasoningLevel: "disabled" } } });
  assert.equal(entry.state, "queued"); assert.equal(entry.managed, true);
  assert.equal(entry.decision.fallbackReasonCode, "stepcode.community.optionsDeferred");
  assert.equal(entry.modelSelection.options.reasoningLevel, "disabled");
  assert.equal(ctx.primarySession.modelSelection.options.reasoningLevel, "enabled");
});

test("prepared: concurrent rename and config refresh leave native and owner title at the new value", async t => {
  const { ctx, file } = await fixture(t);
  ctx.renameSessionInIndex = () => {};
  Object.assign(ctx, createSessionAdmin(ctx));
  await writeFile(file, JSON.stringify(document({ apiKey: "fixture-new" })));
  const name = ctx.client.setSessionName.bind(ctx.client);
  t.mock.method(ctx.client, "setSessionName", async title => { await new Promise(resolve => setTimeout(resolve, 15)); return name(title); });
  await Promise.all([ctx.sessionAdmin.renameSession({ sessionId: "runtime", title: "new-title" }), ctx.ensureClient()]);
  assert.equal(ctx.primarySession.title, "new-title");
  assert.equal((await ctx.client.getState()).sessionName, "new-title");
});

test("prepared: rename observed during the rebuild null-client window waits for the same owner", async t => {
  const { ctx, file } = await fixture(t), original = ctx.client;
  ctx.renameSessionInIndex = () => {}; Object.assign(ctx, createSessionAdmin(ctx));
  ctx.options.stepEnv.STEPCODE_STORAGE_ROOT_DIR = join(ctx.STATE_DIR, "isolated-runtime");
  await writeFile(file, JSON.stringify(document({ apiKey: "fixture-gap" })));
  let rename;
  const observed = new Promise(resolve => original.onFailure(() => setImmediate(() => {
    if (ctx.client !== null || rename) return;
    rename = ctx.sessionAdmin.renameSession({ sessionId: "runtime", title: "new-gap-title" });
    resolve();
  })));
  const refresh = ctx.ensureClient();
  await observed; await Promise.all([refresh, rename]);
  assert.equal(ctx.primarySession.title, "new-gap-title");
  assert.equal((await ctx.client.getState()).sessionName, "new-gap-title");
});

test("prepared: same-model reasoning selection is applied before prompt and kept in the session", async t => {
  const { ctx } = await fixture(t);
  await ctx.admitAndSend({ commandId: "reasoning", text: "hello", modelSelection: { ...selection, options: { reasoningLevel: "low" } } });
  assert.equal((await ctx.client.getState()).thinkingLevel, "low");
  assert.equal(ctx.primarySession.thoughtLevel, "low"); assert.equal(ctx.primarySession.modelSelection.options.reasoningLevel, "low");
});

for (const [reasoningLevel, expected] of [["disabled", "off"], ["enabled", "high"]]) test(`prepared: UI ${reasoningLevel} uses a reported native thinking level`, async t => {
  const { ctx } = await fixture(t);
  if (reasoningLevel === "enabled") await ctx.client.setThinkingLevel("off");
  await ctx.admitAndSend({ commandId: "alias", text: "hello", modelSelection: { ...selection, options: { reasoningLevel } } });
  assert.equal((await ctx.client.getState()).thinkingLevel, expected);
  assert.equal(ctx.primarySession.thoughtLevel, expected);
  assert.equal(ctx.primarySession.modelSelection.options.reasoningLevel, reasoningLevel);
});

test("prepared: unknown reasoning is rejected before prompt and valid selection can recover", async t => {
  const { ctx } = await fixture(t);
  await assert.rejects(ctx.admitAndSend({ commandId: "unknown", text: "no", modelSelection: { ...selection, options: { reasoningLevel: "unknown" } } }), /不支持的思考档位/);
  assert.equal(ctx.turnBusy, false);
  await ctx.admitAndSend({ commandId: "valid-reasoning", text: "yes", modelSelection: selection });
  assert.equal((await ctx.client.getState()).thinkingLevel, "high", "未明确选择档位不得重置原有档位");
});

test("prepared: idle stop and old-client late failure cannot end the new run", async t => {
  const { ctx, file } = await fixture(t), original = ctx.client;
  const lateFailure = original.failureListeners[0], lateEvent = original.eventListeners[0];
  const projected = []; ctx.projectStepEvent = event => projected.push(event);
  await writeFile(file, JSON.stringify(document({ apiKey: "fixture-b" })));
  await ctx.ensureClient();
  assert.equal(projected.some(event => event.type === "step_client_failed"), false, "正常idle刷新不是失败终态");
  ctx.turnBusy = true; ctx.currentTurnId = "new-run";
  lateFailure(Error("late old exit")); lateEvent({ type: "agent_start" });
  assert.equal(projected.length, 0); assert.equal(ctx.turnBusy, true);
});

test("prepared: explicit new-session reset can replace an already exited client", async t => {
  const { ctx } = await fixture(t), original = ctx.client;
  await original.prompt("mock:exit130"); await original.waitForExit(2000);
  await ctx.runWithPreparedClient({ selection: null, requireIdle: true, reset: true }, client => client.newSession());
  assert.notEqual(ctx.client, original); assert.equal(ctx.client.isRunning(), true);
});

test("prepared: failed initial start discards partial client and rereads corrected environment", async t => {
  const { ctx, file } = await fixture(t);
  await ctx.client.stop(); ctx.client = null; ctx.clientStartPromise = null;
  await writeFile(file, "{invalid");
  await assert.rejects(ctx.ensureClient(), /模型配置不可读取/);
  assert.equal(ctx.client, null); assert.equal(ctx.clientStartPromise, null);
  ctx.options.stepEnv.STEP_API_KEY = "fixture-corrected";
  await writeFile(file, JSON.stringify(document())); await ctx.ensureClient();
  assert.equal(ctx.client.options.env.STEP_API_KEY, "fixture-corrected");
});

test("prepared: Host projection failure holds accepted queue without sending; user resumes after publication", async t => {
  const { ctx } = await fixture(t), original = ctx.client;
  ctx.options.stepEnv.STEPCODE_HOST_MODEL_ADMISSION = "1";
  let ready = false, prompts = 0;
  ctx.requestHost = async (method, params) => {
    assert.equal(method, "interaction/prepareModelExecution"); assert.equal(params.workspace.workspaceKey, ctx.STATE_DIR);
    return ready ? { ready: true } : { ready: false, error: { code: "model_projection_failed", message: "fixture sync failed" } };
  };
  const prompt = ctx.client.prompt;
  t.mock.method(ctx.client, "prompt", async function (...args) { prompts++; return prompt.apply(this, args); });
  ctx.turnBusy = true; const entry = await ctx.admitAndSend({ commandId: "host-queued", text: "keep" });
  ctx.turnBusy = false; ctx.scheduleQueueDrain(); await ctx.runInputOperation(async () => {});
  assert.equal(entry.state, "queued"); assert.equal(ctx.ledger.frozen, true); assert.equal(prompts, 0); assert.equal(ctx.client, original);
  ready = true; await ctx.manageQueue({ sessionId: "runtime", type: "setAutoDrain", payload: { autoDrain: true } }); await ctx.runInputOperation(async () => {});
  assert.equal(prompts, 1); assert.equal(entry.state, "submitted");
});

test("prepared: Host selected-model eligibility rejects retained legacy file and permits a new valid choice", async t => {
  const { ctx } = await fixture(t); ctx.options.stepEnv.STEPCODE_HOST_MODEL_ADMISSION = "1";
  ctx.requestHost = async (_method, params) => !params.selection || params.selection.modelId === alternate.modelId
    ? { ready: true } : { ready: false, error: { code: "model_selection_unavailable", message: "provider removed from Registry" } };
  await assert.rejects(ctx.admitAndSend({ commandId: "ineligible", text: "no" }), /provider removed/);
  assert.equal(ctx.turnBusy, false);
  await ctx.admitAndSend({ commandId: "eligible", text: "yes", modelSelection: alternate });
  assert.equal(ctx.primarySession.modelSelection.modelId, alternate.modelId);
});

test("prepared: Host declared without a reverse channel closes execution, standalone unflagged clients stay independent", async t => {
  const { ctx } = await fixture(t); ctx.options.stepEnv.STEPCODE_HOST_MODEL_ADMISSION = "1";
  await assert.rejects(ctx.admitAndSend({ commandId: "missing-port", text: "no" }), /反向请求通道不可用/);
  assert.equal(ctx.turnBusy, false);
  delete ctx.options.stepEnv.STEPCODE_HOST_MODEL_ADMISSION;
  await ctx.admitAndSend({ commandId: "standalone", text: "yes" });
  assert.equal(ctx.ledger.entries.get("standalone").state, "submitted");
});

test("prepared: trusted workspace identity and remote session reference reach the Host; mismatched identity is blocked", async t => {
  const { ctx } = await fixture(t); ctx.options.stepEnv.STEPCODE_HOST_MODEL_ADMISSION = "1";
  ctx.primarySession.workspace = { workspacePath: ctx.STATE_DIR, workspaceKey: "trusted-remote", workspaceIdentity: "trusted-remote", remoteSessionId: "remote-session" };
  ctx.requestHost = async (_method, params) => {
    assert.equal(params.workspace.workspaceKey, params.workspace.workspaceIdentity); assert.equal(params.workspace.remoteSessionId, "remote-session");
    return params.workspace.workspaceIdentity === "trusted-remote" ? { ready: true } : { ready: false, error: { message: "workspace mismatch" } };
  };
  await ctx.assertModelAdmission();
  ctx.primarySession.workspace.workspaceIdentity = "foreign-identity";
  await assert.rejects(ctx.admitAndSend({ commandId: "foreign", text: "no" }), /workspace mismatch/);
  assert.equal(ctx.turnBusy, false);
});

test("prepared: legacy same-model omitted options return inherited actual selection", async t => {
  const { ctx } = await fixture(t); ctx.primarySession.modelSelection = { ...selection, options: { reasoningLevel: "enabled" } };
  const result = await createSessionMethods(ctx)["session/setModel"]({ model: selection });
  assert.equal(result.settings.model.current.options.reasoningLevel, "enabled");
});

test("prepared: default-model failure returns the SDK actual fallback instead of the requested model", async t => {
  const { ctx } = await fixture(t), setModel = StepCodeRpcClient.prototype.setModel;
  ctx.stateRevision = 0;
  t.mock.method(StepCodeRpcClient.prototype, "setModel", async function (provider, id) {
    if (provider === "step") { await setModel.call(this, "mock", "mock-mini"); throw Error("default unavailable"); }
    return setModel.call(this, provider, id);
  });
  const result = await createSessionMethods(ctx)["session/create"]({ sessionId: "fallback", workspace: { workspacePath: ctx.STATE_DIR }, mode: "build" });
  assert.deepEqual(result.settings.model.current, selection); assert.deepEqual(ctx.primarySession.modelSelection, selection);
});

test("prepared: actor Host admission blocks before spawn, then blocks an ask without sending, then valid publication runs", async t => {
  const { ctx } = await fixture(t), starts = t.mock.method(StepCodeRpcClient.prototype, "start"), requests = [];
  const prompt = StepCodeRpcClient.prototype.prompt;
  t.mock.method(StepCodeRpcClient.prototype, "prompt", function (...args) { requests.push(args[0]); return prompt.apply(this, args); });
  let ready = false, settle;
  const sink = { askProgress() {}, askStats() {}, askFailed: (_instance, error) => settle({ error }), askTurnEnded: (_instance, text) => settle({ text }) };
  const instance = { siteId: "actor", ordinal: 0 };
  const driver = createStepWorkflowDriver({
    communicationMode: "mock", command: ctx.spawnCommand, cwd: ctx.STATE_DIR, model: { ...selection, options: { reasoningLevel: "enabled" } },
    env: { STEP_CODING_AGENT_DIR: join(ctx.STATE_DIR, "agent") }, actorRoot: join(ctx.STATE_DIR, "actors"), runId: "actor-gate",
    conversationRoot: join(ctx.STATE_DIR, "conversations"), parentSessionId: "runtime", journal: { getActor: () => ({ name: "actor" }) },
    prepareModelExecution: async () => { if (!ready) throw Error("actor projection failed"); },
  }, sink);
  ctx.disposeTestActors = async () => { driver.dispose(); await driver.closed; };
  await assert.rejects(driver.createActorSession(instance, {}), /actor projection failed/); assert.equal(starts.mock.callCount(), 0);
  ready = true; const actor = await driver.createActorSession(instance, {});
  ready = false; const blocked = new Promise(resolve => { settle = resolve; }); driver.startAsk(actor, instance, { instructions: "no" });
  assert.match((await blocked).error.message, /actor projection failed/); assert.equal(requests.length, 0); driver.respondToSubmit(instance, { kind: "accept" });
  ready = true; const completed = new Promise(resolve => { settle = resolve; }); driver.startAsk(actor, instance, { instructions: "yes" });
  assert.match((await completed).text, /mock reply to/); assert.equal(requests.length, 1); driver.respondToSubmit(instance, { kind: "accept" });
});

for (const [raw, code] of [["401 invalid api key", "invalid_credentials"], ["403 Forbidden", "permission_denied"], ["404 Not Found", "model_unavailable"], ["timeout", "connection_failed"], ["429 Too Many Requests", "rate_limited"], ["unknown fault", "send_failed"]]) {
  test(`send fault: ${code} identifies actual provider without official brand guidance`, () => {
    const fault = classifyStepSendFault(Error(raw), { providerId: "unknown-custom-service", modelId: "chosen-model" });
    assert.equal(fault.code, code); assert.equal(fault.raw, raw);
    assert.match(fault.message, /unknown-custom-service/);
    assert.doesNotMatch(fault.message, /阶跃|套餐|登录页/);
  });
}
