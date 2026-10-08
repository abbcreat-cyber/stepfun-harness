import assert from "node:assert/strict";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectedClient, protocols } from "./provider-wire-fixtures.mjs";
import { automationHttpFixture } from "./desktop-automation-http-fixture.mjs";
import { desktopAutomationEnvironment } from "../src/desktop-automation.mjs";
import { createFixtureTaskAdapter } from "./desktop-automation-task-fixture.mjs";
import { DatabaseSync } from "node:sqlite";

const http = await automationHttpFixture();
let fixture, agent, taskAdapter;
try {
  fixture = await projectedClient(protocols[0], http.baseUrl);
  process.env.ZCODE_DATA_BASE_DIR = fixture.root;
  const { createZCodeAgentService, AutomationRepo } = await import("../../services/src/node.ts");
  const { formatModelPickerValue } = await import("@zcode/shared");
  const stateDir = join(fixture.root, "worker-state"),
    runtimeRoot = join(fixture.root, "runtime-storage");
  await mkdir(stateDir);
  await mkdir(runtimeRoot);
  const env = desktopAutomationEnvironment({
    ...fixture.env,
    ZCODE_DATA_BASE_DIR: fixture.root,
    STEPCODE_STORAGE_ROOT_DIR: runtimeRoot,
  });
  const scope = { workspacePath: fixture.root, workspaceIdentity: "host-fixture-identity" };
  const sessionId = "host-automation-fixture";
  const target = { ...scope, sessionId };
  const model = {
    providerId: fixture.providerId,
    modelId: fixture.modelId,
    options: { reasoningLevel: "high" },
  };
  const events = [];
  const makeAgent = () =>
    createZCodeAgentService({
      requestTimeoutMs: 30000,
      modelSelectionReadinessSource: {
        getView: async () => ({ revision: 1, providers: [fixture.registryView] }),
      },
      waitForModelAdmission: async (selection) => {
        if (selection) {
          assert.equal(selection.providerId, fixture.providerId);
          assert.equal(selection.modelId, fixture.modelId);
        }
      },
      commandResolver: () => ({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../bin/zcode-bridge.mjs", import.meta.url)),
          "--step-cli",
          JSON.stringify([
            process.env.STEP_TEST_CLI,
            "--mode",
            "rpc",
            "--no-extensions",
            "--approval-mode",
            "auto",
          ]),
          "--state-dir",
          stateDir,
          "--step-cwd",
          fixture.root,
          "--auto-approve",
          "1",
        ],
        cwd: fixture.root,
        env,
      }),
    });
  agent = makeAgent();
  const snapshot = await agent.createSession({ ...target, model, mode: "edit" });
  assert.equal(snapshot.session.sessionId, sessionId);
  taskAdapter = await createFixtureTaskAdapter(agent);
  const warmMeta = await taskAdapter.resumeTask({
    ...scope,
    taskId: sessionId,
    model: formatModelPickerValue(model),
    thoughtLevel: "high",
  });
  const indexSnapshot = () => {
    const database = new DatabaseSync(join(fixture.root, ".zcode/v2/tasks-index.sqlite"), {
      readOnly: true,
    });
    try {
      return database
        .prepare("SELECT created_at, cron_automation_id FROM tasks WHERE task_id = ?")
        .get(sessionId);
    } finally {
      database.close();
    }
  };
  const indexBefore = indexSnapshot();
  const subscription = agent.onDynamicSessionEvent(target)((event) => events.push(event));
  let turn = 0;
  async function send(name, args, metadata = {}) {
    const before = events.length;
    http.requests.length = 0;
    http.set({ kind: "tool", name, args, text: "offline response" });
    await agent.sendPrompt({ ...target, content: `fixture ${++turn}`, ...metadata });
    const until = Date.now() + 25000;
    while (
      !events
        .slice(before)
        .some((event) => event.event?.type === "turn.completed" || event.type === "turn.completed")
    ) {
      if (Date.now() > until)
        throw new Error(`Host fixture turn timed out: ${JSON.stringify(events.slice(before))}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await send("cron_create", {
    cron: "0 9 * * *",
    title: "Host 09:00",
    prompt: "offline future prompt",
    durable: false,
  });
  const list = await agent.listAllAutomations();
  assert.equal(list.length, 1, JSON.stringify(events));
  const automation = list[0];
  assert.equal(automation.targetTaskId, sessionId);
  assert.equal(automation.workspaceKey, scope.workspaceIdentity);
  assert.deepEqual(automation.modelSelection, model);
  assert.equal(automation.mode, "edit");
  const next = new Date(automation.nextRunAt);
  assert.deepEqual(
    [next.getHours(), next.getMinutes(), next.getSeconds(), next.getMilliseconds()],
    [9, 0, 0, 0],
  );
  const nativeFile = await access(join(fixture.root, ".stepcode/cron/tasks.json")).then(
    () => true,
    () => false,
  );
  assert.equal(nativeFile, false);
  assert.equal(indexSnapshot().cron_automation_id, automation.automationId);
  const guardResults = [];
  for (const [name, args] of [
    ["cron_create", { cron: "0 9 * * *", prompt: "recursive" }],
    ["cron_delete", { id: automation.automationId }],
  ]) {
    const guardTarget = { ...scope, sessionId: `automatic-${name}` };
    await agent.createSession({ ...guardTarget, model, mode: "edit" });
    const guardEvents = [];
    const guardSubscription = agent.onDynamicSessionEvent(guardTarget)((event) =>
      guardEvents.push(event),
    );
    http.requests.length = 0;
    http.set({ kind: "tool", name, args, text: "guarded" });
    await agent.sendConversationCommandV4({
      ...scope,
      envelope: {
        commandId: `automatic-${name}`,
        sessionId: guardTarget.sessionId,
        type: "sendText",
        payload: {
          text: "automatic fixture",
          automationId: automation.automationId,
          modelSelection: model,
          mode: "edit",
          toolDisallowlist: ["CronCreate", "CronDelete", "cron_create", "cron_delete"],
        },
      },
    });
    const until = Date.now() + 25000;
    while (
      !guardEvents.some(
        (event) => event.event?.type === "turn.completed" || event.type === "turn.completed",
      )
    ) {
      if (Date.now() > until) throw new Error("Automatic turn fixture timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    guardSubscription.dispose();
    const saved = JSON.parse(
      await readFile(join(stateDir, "conversations", `${guardTarget.sessionId}.json`), "utf8"),
    );
    const result = saved.rows.find((row) => row.kind === "toolCall" && row.toolName === name);
    assert.equal(result.status, "error", JSON.stringify(result));
    assert.match(result.output.text, /while running a scheduled task/);
    assert.equal((await agent.listAllAutomations()).length, 1);
    guardResults.push({ name, status: result.status, output: result.output });
  }
  subscription.dispose();
  await taskAdapter.disposeAllAndWait();
  taskAdapter = null;
  // 真 Host+worker+SDK 全部重建；DB 是唯一持久事实。
  agent = makeAgent();
  taskAdapter = await createFixtureTaskAdapter(agent);
  const requestsBeforeResume = http.requests.length;
  const meta = await taskAdapter.resumeTask({
    ...scope,
    taskId: sessionId,
    automationId: automation.automationId,
    model: formatModelPickerValue(model),
    thoughtLevel: "high",
  });
  assert.equal(meta.taskId, sessionId);
  assert.equal(meta.cronAutomationId, automation.automationId);
  assert.equal(meta.createdAt, warmMeta.createdAt);
  assert.equal(indexSnapshot().created_at, indexBefore.created_at);
  assert.equal(http.requests.length, requestsBeforeResume, "resume must not execute a model");
  const restarted = await agent.listAllAutomations();
  assert.equal(restarted[0].automationId, automation.automationId);
  const repo = new AutomationRepo(join(fixture.root, ".zcode/v2/tasks-index.sqlite"));
  assert.equal(await repo.hasTaskBinding({ ...scope, targetTaskId: sessionId }), true);
  repo.close();
  const persisted = JSON.parse(
    await readFile(join(stateDir, "conversations", `${sessionId}.json`), "utf8"),
  );
  const rows = persisted.rows.filter((row) => row.kind === "toolCall");
  assert.equal(rows[0].status, "success");
  assert.ok(rows[0].output.text.includes(automation.automationId));
  http.requests.length = 0;
  http.set({ kind: "text", text: "AUTOMATION_RUN_OK" });
  // HostCronRun 的绑定任务执行入口：resumeTask 后，同一 adapter sendPrompt 传递自动轮身份。
  await taskAdapter.sendPrompt({
    taskId: sessionId,
    traceId: "fixture-automation-run",
    content: "scheduled offline run",
    modelSelection: model,
    automationId: automation.automationId,
  });
  const until = Date.now() + 25000;
  let afterRun;
  while (true) {
    afterRun = JSON.parse(
      await readFile(join(stateDir, "conversations", `${sessionId}.json`), "utf8"),
    );
    if (
      afterRun.rows.some(
        (row) => row.kind === "assistantText" && row.text?.includes("AUTOMATION_RUN_OK"),
      )
    )
      break;
    if (Date.now() > until) throw new Error("Public CronRun consumer did not finish");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(afterRun.session.sessionId, sessionId);
  assert.ok(
    afterRun.rows.some(
      (row) => row.kind === "toolCall" && row.output?.text?.includes(automation.automationId),
    ),
  );
  assert.equal(http.requests.length, 1);
  // 有明确完成条件的原生 goal 可继续执行，但自主续轮不能删除自己的桌面任务。
  http.requests.length = 0;
  http.setSequence([
    {
      kind: "tool",
      name: "create_goal",
      args: {
        objective: "Finish this isolated offline fixture after two short observations",
        token_budget: 1000,
      },
    },
    { kind: "text", text: "First observation done; continuing" },
    { kind: "tool", name: "cron_delete", args: { id: automation.automationId } },
    { kind: "tool", name: "update_goal", args: { status: "complete" } },
    { kind: "text", text: "FINITE_GOAL_DONE" },
  ]);
  await taskAdapter.sendPrompt({
    taskId: sessionId,
    traceId: "fixture-finite-goal",
    content: "run bounded offline goal",
    modelSelection: model,
    automationId: automation.automationId,
  });
  const goalDeadline = Date.now() + 25000;
  let goalRun;
  while (true) {
    goalRun = JSON.parse(
      await readFile(join(stateDir, "conversations", `${sessionId}.json`), "utf8"),
    );
    if (
      goalRun.rows.some(
        (row) => row.kind === "assistantText" && row.text?.includes("FINITE_GOAL_DONE"),
      )
    )
      break;
    if (Date.now() > goalDeadline) throw new Error("Finite native goal did not finish");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const autonomousDelete = goalRun.rows.findLast(
    (row) => row.kind === "toolCall" && row.toolName === "cron_delete",
  );
  await writeFile(
    join(fixture.root, "goal-boundary-probe.json"),
    JSON.stringify({ goalRun, requests: http.requests, autonomousDelete }, null, 2),
  );
  assert.equal(autonomousDelete.status, "error", JSON.stringify(autonomousDelete));
  assert.match(autonomousDelete.output.text, /while running a scheduled task/);
  assert.equal((await agent.listAllAutomations()).length, 1);
  // 下一明确手动输入重新获取普通权限；历史 goal/automatic 文字不能永久锁住删除。
  http.requests.length = 0;
  http.set({
    kind: "tool",
    name: "cron_delete",
    args: { id: automation.automationId },
    text: "MANUAL_DELETE_DONE",
  });
  await taskAdapter.sendPrompt({
    taskId: sessionId,
    traceId: "fixture-manual-delete",
    content: "delete fixture manually",
    modelSelection: model,
  });
  const manualDeadline = Date.now() + 25000;
  while ((await agent.listAllAutomations()).length) {
    if (Date.now() > manualDeadline)
      throw new Error("Next manual input did not release automatic scope");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const evidence = {
    pass: true,
    root: fixture.root,
    automation,
    actualHostHandler: true,
    workerScopedIdentity: true,
    fullProcessRestart: true,
    managementApi: true,
    nativeFile,
    rows,
    events,
    guardResults,
    boundCronRunConsumer: true,
    resumeModelRequests: 0,
    afterRun,
    goalRun,
    autonomousDelete,
    nextManualDelete: true,
    indexBefore,
    indexAfterResume: { created_at: meta.createdAt, cron_automation_id: meta.cronAutomationId },
  };
  const evidencePath = join(fixture.root, "host-automation-evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({ pass: true, evidence: evidencePath }));
} finally {
  await taskAdapter?.disposeAllAndWait();
  await agent?.disposeAllAndWait();
  await http.close();
}
