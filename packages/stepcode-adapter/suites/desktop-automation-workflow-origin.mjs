import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { InputLedger } from "../src/input-admission.mjs";
import { createClientRuntime } from "../src/bridge/client-runtime.mjs";
import { createSessionLifecycle } from "../src/bridge/session-lifecycle.mjs";
import { createProjection } from "../src/bridge/projection.mjs";
import { createDesktopAutomationPort } from "../src/desktop-automation-port.mjs";

for (const startsAutomatic of [true, false])
  test(`workflow launch ${startsAutomatic ? "auto→manual" : "manual→auto"} keeps the run's original task scope`, async (t) => {
    const base = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-wire-tests";
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "workflow-origin-"));
    const ctx = {
      options: { communicationMode: "mock" },
      STATE_DIR: root,
      primarySession: {
        sessionId: "own",
        workspace: { workspacePath: root },
        modelSelection: { providerId: "mock", modelId: "mock-mini" },
        mode: "edit",
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
    };
    Object.assign(ctx, createSessionLifecycle(ctx), createClientRuntime(ctx));
    ctx.runWithPreparedClient = async (_options, fn) => fn(ctx.client);
    const projection = createProjection(ctx);
    t.after(async () => {
      projection.flushStreamDeltas();
      await ctx.workflowBridge.close();
    });

    const input = (automatic) => ({
      commandId: automatic ? "automatic-input" : "manual-input",
      text: "fixture",
      ...(automatic
        ? {
            automationId: "original-auto",
            toolDisallowlist: ["CronCreate", "CronDelete"],
            botDeliveryTarget: { fixture: "original" },
          }
        : {}),
    });
    ctx.ledger.begin(input(startsAutomatic));
    projection.projectStepEvent({ type: "agent_start" });
    const source = {
      sessionId: "own",
      activeAutomationId: ctx.activeAutomationId,
      toolDisallowlist: ctx.activeToolDisallowlist,
      botDeliveryTarget: ctx.activeBotDeliveryTarget,
    };
    const service = await ctx.workflowBridge.service("own");
    await service.guide();
    service.options.confirm = async () => ({ approved: true });
    const params = {
      script: 'const r=await world.run("node", ["-e", "setTimeout(()=>{},100)"]);return "done";',
    };
    // Tool admission 与生产相同：运行中的工具行和输入必须精确匹配。
    ctx.conversationRows.push({
      kind: "toolCall",
      toolName: "CreateWorkflow",
      toolCallId: "workflow-call",
      turnId: ctx.currentTurnId,
      inputText: JSON.stringify(params),
      status: "running",
    });
    const created = await ctx.workflowBridge.request({ method: "CreateWorkflow", params }, source);
    assert.equal(created.ok, true, JSON.stringify(created));
    const runPromise = service.active.get(created.runId)?.promise;
    assert.ok(runPromise, "actual workflow launch must precede the unrelated input");
    projection.projectStepEvent({ type: "agent_settled" });
    ctx.ledger.begin(input(!startsAutomatic));
    projection.projectStepEvent({ type: "agent_start" });
    const result = await runPromise;
    assert.equal(result.status, "completed", JSON.stringify(result.error));
    const until = Date.now() + 3000;
    let notice;
    while (
      !(notice = [...ctx.ledger.entries.values()].find(
        (entry) => entry.clientId === "stepcode-workflow",
      ))
    ) {
      if (Date.now() > until)
        throw new Error("Workflow completed without its original notification");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(notice.automationId, startsAutomatic ? "original-auto" : undefined);
    assert.deepEqual(
      notice.toolDisallowlist,
      startsAutomatic ? ["CronCreate", "CronDelete"] : undefined,
    );
    assert.deepEqual(
      notice.botDeliveryTarget,
      startsAutomatic ? { fixture: "original" } : undefined,
    );
    assert.equal(notice.state, "queued");
    projection.projectStepEvent({ type: "agent_settled" });
    notice.state = "submitted";
    projection.projectStepEvent({ type: "agent_start" });
    const port = createDesktopAutomationPort(async (method) =>
      method.endsWith("list") ? { automations: [{ automationId: "task" }] } : { deleted: true },
    );
    const remove = () =>
      port({ method: "delete", params: { id: "task" } }, () => ({
        sessionId: "own",
        turnId: ctx.currentTurnId,
        activeAutomationId: ctx.activeAutomationId,
        toolDisallowlist: ctx.activeToolDisallowlist,
      }));
    if (startsAutomatic) await assert.rejects(remove(), /Cannot delete/);
    else assert.deepEqual(await remove(), { deleted: true });
  });

for (const closesBeforeAdmission of [true, false])
  test(`shutdown ${closesBeforeAdmission ? "before notice" : "while notice waits"} never sends a model prompt`, async () => {
    let sends = 0,
      queued = 0;
    const ctx = {
      options: { communicationMode: "mock" },
      STATE_DIR: "D:/fixture",
      primarySession: { sessionId: "own" },
      client: { isRunning: () => true },
      shuttingDown: closesBeforeAdmission,
      admitAndSend: async () => {
        sends++;
      },
      runInputOperation: async (operation) => {
        queued++;
        ctx.shuttingDown = true;
        return operation();
      },
    };
    await createClientRuntime(ctx).notifyWorkflowCompletion(
      "own",
      { runId: "closing-run", status: "errored" },
      { automationId: "auto" },
    );
    assert.equal(sends, 0);
    assert.equal(queued, closesBeforeAdmission ? 0 : 1);
  });
