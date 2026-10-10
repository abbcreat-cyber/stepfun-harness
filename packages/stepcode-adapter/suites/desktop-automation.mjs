import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createDesktopAutomationPort } from "../src/desktop-automation-port.mjs";
import {
  desktopAutomationEnvironment,
  withDesktopAutomation,
  assertDesktopAutomationLoaded,
} from "../src/desktop-automation.mjs";
import { startEmbeddedBrowserRelay } from "../src/embedded-browser-relay.mjs";
import { InputLedger } from "../src/input-admission.mjs";
import { createSessionMethods } from "../src/bridge/methods-session.mjs";
import { createProjection } from "../src/bridge/projection.mjs";
import { createClientRuntime } from "../src/bridge/client-runtime.mjs";
import { createSessionLifecycle } from "../src/bridge/session-lifecycle.mjs";

const own = () => ({
  sessionId: "own",
  turnId: "turn",
  activeTurn: true,
  desktopTaskMode: true,
  modelSelection: { providerId: "fixture", modelId: "model", options: { reasoningLevel: "high" } },
  mode: "edit",
});
const create = {
  method: "create",
  params: { cron: "0 9 * * *", prompt: "offline", durable: false },
};

test("desktop assembly disables native scheduler; standalone command stays native", async () => {
  const cmd = ["step.exe", "--mode", "rpc"];
  assert.equal(withDesktopAutomation(cmd), cmd);
  assert.equal(desktopAutomationEnvironment({}).STEP_DISABLE_CRON, "1");
  const env = desktopAutomationEnvironment({});
  assert.throws(
    () => withDesktopAutomation(cmd, { env: { STEPCODE_TASK_MODE: "desktop" } }),
    /disabled/,
  );
  const injected = withDesktopAutomation(cmd, { env });
  assert.equal(withDesktopAutomation(injected, { env }), injected);
  await assert.rejects(
    assertDesktopAutomationLoaded({ options: { env }, getCommands: async () => [] }),
    /failed/,
  );
});

test("create forwards current identity model permission and delivery, never model-supplied scope", async () => {
  const calls = [],
    context = { ...own(), botDeliveryTarget: { fixture: true } };
  const port = createDesktopAutomationPort(async (method, params) => {
    calls.push({ method, params });
    return method.endsWith("checkTaskBinding")
      ? { bound: false }
      : { automation: { automationId: "db-id" } };
  });
  assert.equal((await port(create, () => context)).automation.automationId, "db-id");
  assert.deepEqual(calls[1].params, {
    cronExpr: "0 9 * * *",
    prompt: "offline",
    title: "",
    recurring: true,
    targetTaskId: "own",
    modelSelection: context.modelSelection,
    mode: "edit",
    botDeliveryTarget: context.botDeliveryTarget,
  });
  for (const key of ["workspacePath", "sessionId", "targetTaskId", "modelSelection", "mode"])
    await assert.rejects(
      port({ ...create, params: { ...create.params, [key]: "foreign" } }, () => context),
      /Invalid/,
    );
  assert.equal(calls.length, 2);
});

test("bound, unknown, recursive and disallowed create never reach write", async () => {
  for (const [context, result] of [
    [own(), { bound: true }],
    [own(), {}],
    [{ ...own(), activeAutomationId: "auto" }, { bound: false }],
    [{ ...own(), toolDisallowlist: ["CronCreate"] }, { bound: false }],
  ]) {
    const port = createDesktopAutomationPort(async (method) => {
      assert.equal(method, "automation/checkTaskBinding");
      return result;
    });
    await assert.rejects(port(create, () => context));
  }
  const port = createDesktopAutomationPort(async () => {
    throw new Error("Host unavailable");
  });
  await assert.rejects(port(create, own), /Host unavailable/);
});

test("parallel creates serialize admission and binding; transport failure is not retried", async () => {
  let bound = false,
    writes = 0;
  const port = createDesktopAutomationPort(async (method) => {
    if (method.endsWith("checkTaskBinding")) return { bound };
    writes++;
    bound = true;
    throw new Error("commit reply lost");
  });
  const results = await Promise.allSettled([port(create, own), port(create, own)]);
  assert.equal(writes, 1);
  assert.match(results[0].reason.message, /reply lost/);
  assert.match(results[1].reason.message, /already belongs/);
});

test("late binding check cannot write after owner turn changes", async () => {
  let context = own();
  const port = createDesktopAutomationPort(async (method) => {
    assert.equal(method, "automation/checkTaskBinding");
    context = { ...context, turnId: "next" };
    return { bound: false };
  });
  await assert.rejects(
    port(create, () => context),
    /stale/,
  );
});

test("delete keeps workspace scope and rejects automatic-turn writes", async () => {
  const calls = [],
    port = createDesktopAutomationPort(async (method, params) => {
      calls.push({ method, params });
      return method.endsWith("list")
        ? { automations: [{ automationId: "own-id" }] }
        : { deleted: true };
    });
  assert.deepEqual(await port({ method: "delete", params: { id: "foreign-id" } }, own), {
    deleted: false,
  });
  assert.equal(calls.length, 1);
  await assert.rejects(
    port({ method: "delete", params: { id: "own-id" } }, () => ({
      ...own(),
      activeAutomationId: "auto",
    })),
    /Cannot delete/,
  );
  assert.equal(calls.length, 1);
  assert.equal((await port({ method: "delete", params: { id: "own-id" } }, own)).deleted, true);
});

test("session allowlist and both canonical/native denylists constrain task tools", async () => {
  let calls = 0;
  const port = createDesktopAutomationPort(async (method) => {
    calls++;
    return method.endsWith("list") ? { automations: [] } : { bound: false };
  });
  await assert.rejects(
    port(create, () => ({ ...own(), toolAllowlist: ["CronList"] })),
    /Cannot create/,
  );
  await assert.rejects(
    port({ method: "list" }, () => ({ ...own(), toolDisallowlist: ["cron_list"] })),
    /listing is disallowed/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await port({ method: "list" }, () => ({ ...own(), toolAllowlist: ["CronList"] })),
    { automations: [] },
  );
});

test("missing persistence receipt is a failure and no transport operation is retried", async () => {
  let creates = 0;
  const port = createDesktopAutomationPort(async (method) => {
    if (method.endsWith("checkTaskBinding")) return { bound: false };
    creates++;
    return {};
  });
  await assert.rejects(port(create, own), /did not return a task id/);
  assert.equal(creates, 1);
});

test("PID relay rejects forged scope stale turns and unknown operations", async (t) => {
  const base = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-wire-tests";
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "automation-relay-"));
  let context = own(),
    calls = 0;
  const relay = await startEmbeddedBrowserRelay({
    directory,
    getContext: () => context,
    requestHost: async (method) => {
      calls++;
      return method.endsWith("list") ? { automations: [] } : { bound: false };
    },
  });
  t.after(() => relay.close());
  await relay.bindPid(123);
  const binding = JSON.parse(await readFile(join(directory, "123.json"), "utf8"));
  const endpoint = binding.endpoint.replace("/execute", "/desktop-automation");
  const post = (body) =>
    fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${binding.token}` },
      body: JSON.stringify(body),
    });
  const claims = { sessionId: "own", turnId: "turn" };
  assert.equal((await post({ method: "list", ...claims })).status, 200);
  for (const body of [
    { method: "unknown", ...claims },
    { method: "list", sessionId: "foreign", turnId: "turn" },
    { ...create, ...claims, params: { ...create.params, workspacePath: "foreign" } },
  ])
    assert.equal((await post(body)).status, 400);
  context = { ...context, activeTurn: false };
  assert.equal((await post({ method: "list", ...claims })).status, 400);
  await relay.bindPid(456);
  assert.equal((await post({ method: "list", ...claims })).status, 403);
  assert.equal(calls, 1);
});

test("queued automation metadata is internal and follows attributed input", () => {
  const ledger = new InputLedger();
  ledger.begin({
    commandId: "c",
    text: "scheduled",
    busy: false,
    automationId: "auto",
    toolDisallowlist: ["CronCreate", "CronDelete"],
    botDeliveryTarget: { fixture: true },
  });
  const entry = ledger.attributeNextRun();
  assert.equal(entry.automationId, "auto");
  assert.deepEqual(entry.toolDisallowlist, ["CronCreate", "CronDelete"]);
  assert.deepEqual(entry.botDeliveryTarget, { fixture: true });
  assert.deepEqual(ledger.queueItems(), []);
});

test("bound task resume rejects busy and foreign workspace before restoring native state", async () => {
  let restores = 0;
  const ctx = {
    options: {
      stepEnv: {
        STEPCODE_HOST_WORKSPACE_REF: JSON.stringify({
          workspacePath: "D:/fixture",
          workspaceIdentity: "own",
        }),
      },
    },
    turnBusy: true,
    restoreSession: async () => {
      restores++;
    },
  };
  const resume = createSessionMethods(ctx)["session/resume"];
  await assert.rejects(resume({ sessionId: "own" }), /仍在运行/);
  ctx.turnBusy = false;
  await assert.rejects(
    resume({
      sessionId: "own",
      workspace: { workspacePath: "D:/foreign", workspaceIdentity: "foreign" },
    }),
    /不匹配/,
  );
  await assert.rejects(resume({ sessionId: "" }), /缺少/);
  assert.equal(restores, 0);
});

test("native autonomous continuation keeps Host provenance until the next manual input", () => {
  const ctx = {
    primarySession: { sessionId: "own", workspace: { workspacePath: "D:/fixture" } },
    ledger: new InputLedger(),
    conversationRows: [],
    v4Subscriptions: new Map(),
    eventSeq: 0,
    stateRevision: 0,
    conversationSeq: 0,
    turnBusy: false,
    streamingText: "",
    sessionStatistics: () => ({ handle: () => false }),
    workflowBridge: {},
    notify() {},
    persistPrimarySummary() {},
    broadcastSessionsIndexUpsert() {},
    scheduleQueueDrain() {},
  };
  const projection = createProjection(ctx);
  ctx.ledger.begin({
    commandId: "scheduled",
    text: "scheduled",
    automationId: "auto",
    toolDisallowlist: ["CronCreate", "CronDelete"],
    botDeliveryTarget: { fixture: true },
  });
  projection.projectStepEvent({ type: "agent_start" });
  assert.equal(ctx.activeAutomationId, "auto");
  projection.projectStepEvent({ type: "agent_settled" });
  // 没有新的 Host ledger 输入：真实 SDK goal/原生 follow-up 仍属于上一实际输入。
  projection.projectStepEvent({ type: "agent_start" });
  assert.equal(ctx.activeAutomationId, "auto");
  assert.deepEqual(ctx.activeToolDisallowlist, ["CronCreate", "CronDelete"]);
  assert.deepEqual(ctx.activeBotDeliveryTarget, { fixture: true });
  projection.projectStepEvent({ type: "agent_settled" });
  ctx.ledger.begin({ commandId: "manual", text: "manual" });
  projection.projectStepEvent({ type: "agent_start" });
  assert.equal(ctx.activeAutomationId, undefined);
  assert.equal(ctx.activeToolDisallowlist, undefined);
  assert.equal(ctx.activeBotDeliveryTarget, undefined);
  projection.flushStreamDeltas();
});

test("app actor environment disables native scheduling without claiming the main PID relay", async () => {
  const context = {
    options: {
      stepEnv: {
        STEP_BACKEND: "stepcode-local",
        HOME: "D:/fixture",
        USERPROFILE: "D:/fixture",
        STEP_CODING_AGENT_DIR: "D:/fixture/agent",
        STEPCODE_STORAGE_ROOT_DIR: "D:/fixture/storage",
      },
    },
    STATE_DIR: "D:/fixture",
  };
  const env = await createClientRuntime(context).clientEnvironment();
  assert.equal(env.STEP_DISABLE_CRON, "1");
  assert.equal(env.STEPCODE_TASK_MODE, undefined);
});

test("workflow completion notification inherits automatic scope through the existing ledger", async () => {
  const ctx = {
    options: { communicationMode: "mock" },
    STATE_DIR: "D:/fixture",
    primarySession: {
      sessionId: "own",
      workspace: { workspacePath: "D:/fixture" },
      modelSelection: own().modelSelection,
    },
    client: { isRunning: () => true },
    ledger: new InputLedger(),
    conversationRows: [],
    v4Subscriptions: new Map(),
    eventSeq: 0,
    stateRevision: 0,
    conversationSeq: 0,
    turnBusy: false,
    streamingText: "",
    sessionStatistics: () => ({ handle: () => false }),
    notify() {},
    persistConversation() {},
    persistPrimarySummary() {},
    broadcastConversationSnapshot() {},
    broadcastSessionsIndexUpsert() {},
    scheduleQueueDrain() {},
    attachmentStore: { prepare: async (_id, _attachments, text) => ({ images: [], text }) },
    runInputOperation: async (fn) => fn(),
    runWithPreparedClient: async (_options, fn) => fn(ctx.client),
  };
  Object.assign(ctx, createSessionLifecycle(ctx), createClientRuntime(ctx));
  // 本测试不启动底座；仅跨越真实 notify→admission→ledger→projection 的产品路径。
  ctx.runWithPreparedClient = async (_options, fn) => fn(ctx.client);
  ctx.workflowBridge = {};
  const projection = createProjection(ctx);
  ctx.ledger.begin({
    commandId: "scheduled",
    text: "scheduled",
    automationId: "auto",
    toolDisallowlist: ["CronCreate", "CronDelete"],
    botDeliveryTarget: { fixture: true },
  });
  projection.projectStepEvent({ type: "agent_start" });
  const notice = await ctx.notifyWorkflowCompletion(
    "own",
    {
      runId: "offline",
      status: "completed",
    },
    ctx.primarySession.lastInputTaskContext,
  );
  assert.equal(notice.state, "queued");
  assert.equal(notice.automationId, "auto");
  assert.deepEqual(notice.toolDisallowlist, ["CronCreate", "CronDelete"]);
  assert.deepEqual(notice.botDeliveryTarget, { fixture: true });
  projection.projectStepEvent({ type: "agent_settled" });
  notice.state = "submitted";
  projection.projectStepEvent({ type: "agent_start" });
  assert.equal(ctx.activeAutomationId, "auto");
  const port = createDesktopAutomationPort(async () =>
    assert.fail("automatic notice cannot reach delete Host"),
  );
  await assert.rejects(
    port({ method: "delete", params: { id: "own-id" } }, () => ({
      ...own(),
      activeAutomationId: ctx.activeAutomationId,
    })),
    /Cannot delete/,
  );
  projection.flushStreamDeltas();
});
