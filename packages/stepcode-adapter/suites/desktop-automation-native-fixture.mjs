import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, access } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { httpFixture, projectedClient, protocols } from "./provider-wire-fixtures.mjs";
import { desktopAutomationEnvironment } from "../src/desktop-automation.mjs";
import { startEmbeddedBrowserRelay } from "../src/embedded-browser-relay.mjs";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { verifyNativeActorEnvironment } from "./desktop-automation-actor-fixture.mjs";

const http = await httpFixture(protocols[0]);
let repo, agent, relay, fixture;
const calls = [],
  tools = [];
try {
  fixture = await projectedClient(protocols[0], http.baseUrl);
  process.env.ZCODE_DATA_BASE_DIR = fixture.root;
  const { AutomationService, AutomationRepo, createZCodeAgentService } =
    await import("../../services/src/node.ts");
  const {
    zcodeAutomationCreateParamsSchema,
    zcodeAutomationListParamsSchema,
    zcodeAutomationDeleteParamsSchema,
    zcodeAutomationCheckTaskBindingParamsSchema,
  } = await import("@zcode/shared");
  const dbPath = join(fixture.root, ".zcode/v2/tasks-index.sqlite");
  repo = new AutomationRepo(dbPath);
  const service = new AutomationService(repo);
  // 管理页实际读取的公共 Host API，持久化 owner 与生产的 automation handler 相同。
  agent = createZCodeAgentService();
  const scope = { workspacePath: fixture.root, workspaceIdentity: "fixture-remote-identity" };
  let context = {
    sessionId: "fixture-own-session",
    turnId: "fixture-turn",
    desktopTaskMode: true,
    activeTurn: true,
    modelSelection: {
      providerId: fixture.providerId,
      modelId: fixture.modelId,
      options: { reasoningLevel: "high" },
    },
    mode: "edit",
  };
  const root = join(fixture.root, "runtime-storage");
  await mkdir(root, { recursive: true });
  relay = await startEmbeddedBrowserRelay({
    directory: join(root, "browser-bridges"),
    getContext: () => context,
    requestHost: async (method, params) => {
      calls.push({ method, params });
      if (method === "automation/checkTaskBinding") {
        const parsed = zcodeAutomationCheckTaskBindingParamsSchema.parse(params);
        return { bound: await service.hasTaskBinding({ ...scope, ...parsed }) };
      }
      if (method === "automation/create") {
        const parsed = zcodeAutomationCreateParamsSchema.parse(params);
        return { automation: await service.create({ ...parsed, ...scope }) };
      }
      if (method === "automation/list") {
        zcodeAutomationListParamsSchema.parse(params);
        return { automations: await service.list(scope) };
      }
      if (method === "automation/delete") {
        const parsed = zcodeAutomationDeleteParamsSchema.parse(params);
        return { deleted: await service.delete(parsed.automationId, scope) };
      }
      throw new Error(`Unexpected host method ${method}`);
    },
  });
  fixture.client.options.env = desktopAutomationEnvironment({
    ...fixture.env,
    STEPCODE_STORAGE_ROOT_DIR: root,
  });
  fixture.client.options.onSpawn = (pid) => relay.bindPid(pid);
  fixture.client.uiHandler = async () => ({ confirmed: true });
  fixture.client.onEvent((event) => {
    if (event.type === "tool_execution_end") tools.push(event);
  });
  await fixture.client.start();
  await fixture.client.setModel(fixture.providerId, fixture.modelId);
  await fixture.client.setThinkingLevel("high");
  http.set({
    kind: "tool",
    name: "cron_create",
    args: { cron: "0 9 * * *", prompt: "offline fixture", title: "fixture 09:00", durable: false },
    text: "created",
  });
  await fixture.client.promptAndWait("create offline fixture", { timeoutMs: 20000 });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].isError, false, JSON.stringify(tools[0].result));
  const catalog = http.requests[0].body.tools.map((tool) => tool.function ?? tool);
  for (const name of ["cron_create", "cron_list", "cron_delete"]) {
    assert.equal(catalog.filter((tool) => tool.name === name).length, 1);
    assert.match(catalog.find((tool) => tool.name === name).description, /permanently persisted/);
  }
  let automations = await agent.listAllAutomations();
  assert.equal(automations.length, 1);
  const automation = automations[0];
  assert.equal(automation.targetTaskId, context.sessionId);
  assert.equal(automation.workspaceIdentity, scope.workspaceIdentity);
  assert.deepEqual(automation.modelSelection, context.modelSelection);
  assert.equal(automation.mode, "edit");
  const next = new Date(automation.nextRunAt);
  assert.deepEqual(
    [next.getHours(), next.getMinutes(), next.getSeconds(), next.getMilliseconds()],
    [9, 0, 0, 0],
  );
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("select count(*) as n from automations").get().n, 1);
  db.close();
  assert.equal(
    await access(join(fixture.root, ".stepcode/cron/tasks.json")).then(
      () => true,
      () => false,
    ),
    false,
  );
  await fixture.client.stop();
  repo.close();
  const reopened = new AutomationRepo(dbPath);
  assert.deepEqual(
    (await new AutomationService(reopened).list(scope))[0].automationId,
    automation.automationId,
  );
  reopened.close();
  // 新原生进程读取相同 Host DB；不会尝试 Step 原生 jobs 恢复。
  fixture.client = new StepCodeRpcClient({ ...fixture.client.options });
  fixture.client.uiHandler = async () => ({ confirmed: true });
  await fixture.client.start();
  await fixture.client.setModel(fixture.providerId, fixture.modelId);
  const listEvents = [];
  fixture.client.onEvent((event) => {
    if (event.type === "tool_execution_end") listEvents.push(event);
  });
  http.requests.length = 0;
  http.set({ kind: "tool", name: "cron_list", args: {}, text: "listed" });
  await fixture.client.promptAndWait("list restarted fixture", { timeoutMs: 20000 });
  assert.equal(listEvents.at(-1).isError, false);
  assert.ok(JSON.stringify(listEvents.at(-1).result).includes(automation.automationId));
  const countBefore = calls.filter((call) => call.method === "automation/create").length;
  // 第二个创建不能绕过当前会话已绑定守卫。
  // HTTP fixture 的固定 toolCallId 不应与上一轮历史结果混合；Host 归属仍是同一个会话。
  await fixture.client.newSession();
  http.requests.length = 0;
  http.set({
    kind: "tool",
    name: "cron_create",
    args: { cron: "0 9 * * *", prompt: "duplicate" },
    text: "blocked",
  });
  await fixture.client.promptAndWait("try duplicate", { timeoutMs: 20000 });
  assert.equal(listEvents.at(-1).isError, true, JSON.stringify(listEvents.at(-1)));
  assert.equal(calls.filter((call) => call.method === "automation/create").length, countBefore);
  await fixture.client.stop();
  // 原生工具权限 deny 在 relay 写入之前阻断。
  fixture.client = new StepCodeRpcClient({
    ...fixture.client.options,
    command: [...fixture.client.options.command, "--tool-override", "cron_delete=deny"],
  });
  await fixture.client.start();
  await fixture.client.setModel(fixture.providerId, fixture.modelId);
  http.requests.length = 0;
  http.set({
    kind: "tool",
    name: "cron_delete",
    args: { id: automation.automationId },
    text: "denied",
  });
  await fixture.client.promptAndWait("deny delete", { timeoutMs: 20000 });
  assert.equal((await agent.listAllAutomations()).length, 1);
  assert.equal(calls.filter((call) => call.method === "automation/delete").length, 0);
  await fixture.client.stop();
  fixture.client = new StepCodeRpcClient({
    ...fixture.client.options,
    command: fixture.client.options.command.slice(0, -2),
  });
  fixture.client.uiHandler = async () => ({ confirmed: true });
  await fixture.client.start();
  await fixture.client.setModel(fixture.providerId, fixture.modelId);
  http.requests.length = 0;
  await fixture.client.promptAndWait("delete fixture", { timeoutMs: 20000 });
  assert.equal((await agent.listAllAutomations()).length, 0);
  await fixture.client.stop();
  context = { ...context, sessionId: "deny-unbound-session" };
  fixture.client = new StepCodeRpcClient({
    ...fixture.client.options,
    command: [...fixture.client.options.command, "--tool-override", "cron_create=deny"],
  });
  await fixture.client.start();
  await fixture.client.setModel(fixture.providerId, fixture.modelId);
  http.requests.length = 0;
  http.set({
    kind: "tool",
    name: "cron_create",
    args: { cron: "0 9 * * *", prompt: "must be denied" },
    text: "denied",
  });
  await fixture.client.promptAndWait("deny creation", { timeoutMs: 20000 });
  assert.equal((await agent.listAllAutomations()).length, 0);
  assert.equal(calls.filter((call) => call.method === "automation/create").length, countBefore);
  await fixture.client.stop();
  // 独立 CLI 未声明 desktop mode：真实 SDK 保留原 cron 工具，但只查询，不创建 native 任务。
  const hostCallsBeforeStandalone = calls.length;
  fixture.client = new StepCodeRpcClient({
    command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-session", "--no-extensions"],
    env: fixture.env,
    cwd: fixture.root,
  });
  await fixture.client.start();
  await fixture.client.setModel(fixture.providerId, fixture.modelId);
  http.requests.length = 0;
  http.set({ kind: "tool", name: "cron_list", args: {}, text: "native list only" });
  await fixture.client.promptAndWait("standalone list", { timeoutMs: 20000 });
  const standaloneCatalog = http.requests[0].body.tools.map((tool) => tool.function ?? tool);
  assert.match(
    standaloneCatalog.find((tool) => tool.name === "cron_create").description,
    /seven days/,
  );
  assert.equal(calls.length, hostCallsBeforeStandalone);
  await fixture.client.stop();
  const actor = await verifyNativeActorEnvironment(fixture, http);
  const evidence = {
    pass: true,
    root: fixture.root,
    dbPath,
    automation,
    calls,
    nativeTasksFile: false,
    nativeSchedulerDisabled: true,
    sdkToolCatalog: catalog.filter((tool) => tool.name.startsWith("cron_")),
    restartedList: true,
    duplicateBlocked: true,
    deniedDeletePreserved: true,
    deleted: true,
    deniedCreatePreserved: true,
    standaloneNativePreserved: true,
    actor,
  };
  await writeFile(
    join(fixture.root, "automation-evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  process.stdout.write(
    JSON.stringify({ pass: true, evidence: join(fixture.root, "automation-evidence.json") }),
  );
} finally {
  await fixture?.client.stop();
  await relay?.close();
  repo?.close();
  await agent?.disposeAllAndWait();
  await http.close();
}
