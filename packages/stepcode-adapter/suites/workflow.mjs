import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promptUntilSettled, abortUntilSettled } from "../src/workflow/ask-events.mjs";

test("取消的 ACK 不代表工具已收尾，必须等 agent_settled 再释放会话", async () => {
  let handler, listenerReleased = false, abortAcknowledged = false;
  const client = {
    onEvent: callback => { handler = callback; return () => { listenerReleased = true; }; },
    getState: async () => ({ isStreaming: true }),
    abort: async () => { abortAcknowledged = true; },
  };
  const pending = abortUntilSettled(client);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(abortAcknowledged, true);
  assert.equal(listenerReleased, false);
  handler({ type: "tool_execution_end" });
  assert.equal(listenerReleased, false);
  handler({ type: "agent_settled" });
  await pending;
  assert.equal(listenerReleased, true);
});

test("取消空闲 actor 不等待不存在的终态，协议错误仍如实失败", async () => {
  let released = 0;
  const client = { onEvent: () => () => { released++; }, getState: async () => ({ isStreaming: false }), abort: async () => { throw Error("must not abort idle"); } };
  await abortUntilSettled(client);
  assert.equal(released, 1);
  await assert.rejects(abortUntilSettled({ ...client, getState: async () => { throw Error("protocol gone"); } }), /protocol gone/);
  assert.equal(released, 2);
});
import { StepWorkflowService } from "../src/workflow/service.mjs";
import { createWorkflowBridge } from "../src/workflow/bridge.mjs";
const { conversationSnapshotSchema } = await import("@zcode/shared/zcode-protocol-v4");
import { makeConversationSnapshot } from "../src/wire-shapes.mjs";

test("workflow waiter cleans listeners after preflight failure and cancellation", async () => {
  const listeners = new Set(),
    child = new EventEmitter();
  const client = {
    child,
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async prompt() {
      throw new Error("preflight");
    },
  };
  await assert.rejects(promptUntilSettled(client, "test"), /preflight/);
  assert.equal(listeners.size, 0);
  assert.equal(child.listenerCount("exit"), 0);
  client.prompt = async () => {};
  const controller = new AbortController();
  const pending = promptUntilSettled(client, "test", controller.signal);
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(listeners.size, 0);
  assert.equal(child.listenerCount("exit"), 0);
});

test("workflow rejects invalid/denied scripts and persists completed results", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-workflow-"));
  let confirmations = 0,
    approve = false;
  const options = {
    root,
    cwd: root,
    sessionId: "test-session",
    model: { providerId: "mock", modelId: "mock" },
    command: [],
    confirm: async () => {
      confirmations++;
      return { approved: approve };
    },
  };
  let service = new StepWorkflowService(options);
  try {
    await service.guide();
    assert.equal((await service.create({ script: "return !!!;" }, "invalid")).ok, false);
    assert.equal(confirmations, 0);
    assert.equal(
      (await service.create({ script: "return {ok:true};" }, "denied")).status,
      "denied",
    );
    assert.equal(service.list().length, 0);
    approve = true;
    const run = await service.create(
      { script: 'phase("检查"); report({ok:true}); return {ok:true};' },
      "approved",
    );
    await service.active.get(run.runId)?.promise;
    assert.equal(service.detail(run.runId).run.status, "completed");
    const snapshot = makeConversationSnapshot({
      sessionId: "test-session",
      logEpoch: "test",
      seq: 1,
      revision: 1,
      workflowRuns: service.refresh(),
    });
    conversationSnapshotSchema.parse(snapshot);
    await service.close();
    service = new StepWorkflowService(options);
    assert.equal(service.list()[0].status, "completed");
    assert.equal(service.refresh().runs[0].runId, run.runId);
    assert.throws(() => service.detail("foreign-run"), /不属于/);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow confirmation is session-bound and schema valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-workflow-confirm-"));
  const rows = [
    {
      rowId: 1,
      kind: "toolCall",
      toolCallId: "tool-1",
      toolName: "CreateWorkflow",
      status: "running",
    },
  ];
  const bridge = createWorkflowBridge({
    root,
    command: [],
    session: () => ({
      workspace: { workspacePath: root },
      modelSelection: { providerId: "mock", modelId: "mock" },
    }),
    rows: () => rows,
    changed() {},
    completed() {},
  });
  try {
    const service = await bridge.service("session-a");
    await service.guide();
    const input = { script: "return {ok:true};" };
    rows[0].input = input;
    await assert.rejects(
      bridge.request(
        { method: "CreateWorkflow", params: { script: "return 2;" } },
        { sessionId: "session-a" },
      ),
      /没有匹配/,
    );
    const creating = bridge.request(
      { method: "CreateWorkflow", params: input },
      { sessionId: "session-a" },
    );
    let item;
    for (let n = 0; n < 100; n++) {
      item = bridge.snapshot("session-a").pendingInteractions[0];
      if (item) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(item);
    conversationSnapshotSchema.parse(
      makeConversationSnapshot({
        sessionId: "session-a",
        logEpoch: "test",
        seq: 1,
        revision: 1,
        ...bridge.snapshot("session-a"),
      }),
    );
    assert.throws(
      () => bridge.resolve("session-b", item.interactionId, { optionId: "allow" }),
      /不属于/,
    );
    bridge.resolve("session-a", item.interactionId, { optionId: "deny" });
    assert.equal((await creating).status, "denied");
    assert.equal(service.list().length, 0);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow publishes durable markdown and saved definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-artifact-"));
  const options = {
    root,
    cwd: root,
    sessionId: "artifacts",
    model: { providerId: "mock", modelId: "mock" },
    command: [],
    confirm: async () => ({ approved: true }),
  };
  const service = new StepWorkflowService(options);
  try {
    await service.guide();
    const script =
      'await artifact.markdown("report", "# Verified", {title:"Result",primary:true}); return {ok:true};';
    await service.save({ name: "read-check", script });
    assert.equal(service.getSaved({ name: "read-check" }).script, script);
    assert.equal(service.listSaved().workflows.length, 1);
    const run = await service.create({ saved: { name: "read-check" } }, "artifact-tool");
    await service.active.get(run.runId)?.promise;
    assert.equal(
      service.detail(run.runId).run.status,
      "completed",
      JSON.stringify(service.detail(run.runId).run.failure),
    );
    assert.equal(service.artifacts(run.runId).artifacts[0].id, "report");
    const data = await service.artifactRead({
      runId: run.runId,
      artifactId: "report",
      version: 1,
      offset: 0,
      limit: 512,
    });
    assert.equal(Buffer.from(data.dataBase64, "base64").toString(), "# Verified");
    await assert.rejects(
      service.artifactRead({
        runId: "foreign",
        artifactId: "report",
        version: 1,
        offset: 0,
        limit: 512,
      }),
      /不属于/,
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelled workflow resumes after restart and reuses its journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-resume-"));
  const { fileURLToPath } = await import("node:url");
  const command = [
    process.execPath,
    fileURLToPath(new URL("../mock/step-rpc-mock.mjs", import.meta.url)),
    "--delay",
    "150",
  ];
  const options = {
    root,
    cwd: root,
    sessionId: "resume",
    communicationMode: "mock",
    model: { providerId: "step", modelId: "step-5-preview" },
    command,
    confirm: async () => ({ approved: true }),
  };
  let service = new StepWorkflowService(options);
  try {
    await service.guide();
    const run = await service.create(
      {
        script:
          'const r=await world.run("node", ["-e", "setTimeout(()=>console.log(123),1000)"]); return r;',
      },
      "resume-tool",
    );
    await new Promise((r) => setTimeout(r, 200));
    service.cancel(run.runId);
    await service.active.get(run.runId)?.promise;
    assert.equal(service.detail(run.runId).run.status, "stopped");
    await service.close();
    service = new StepWorkflowService(options);
    const resumed = await service.resume(run.runId, "resume-tool");
    assert.equal(resumed.runId, run.runId);
    await service.active.get(run.runId)?.promise;
    assert.equal(
      service.detail(run.runId).run.status,
      "completed",
      JSON.stringify(service.detail(run.runId).run.failure),
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("only abandoned workflow ownership may be reclaimed", async () => {
  const { WorkflowOwnership } = await import("../src/workflow/ownership.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "step-owner-")),
    path = join(root, "owners.sqlite");
  const a = new WorkflowOwnership(path),
    b = new WorkflowOwnership(path);
  try {
    const release = a.claim("live");
    assert.ok(release);
    assert.equal(b.claim("live"), null);
    assert.equal(b.claim("live", true), null);
    release();
    const next = b.claim("live");
    assert.ok(next);
    next();
    assert.equal(a.claim("absent", true), null);
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO owners VALUES(?,?,?)").run("dead", 2147483647, "dead-nonce");
    db.close();
    const recovered = a.claim("dead", true);
    assert.ok(recovered);
    assert.equal(b.claim("dead"), null);
    recovered();
  } finally {
    a.close();
    b.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native Step confirmations keep a cancellable visible permission request", async () => {
  const bridge = createWorkflowBridge({
    root: "unused",
    rows: () => [],
    changed() {},
    completed() {},
    session: () => null,
  });
  const controller = new AbortController();
  const waiting = bridge.permission(
    "session",
    { method: "confirm", id: "native-tool", title: "Approve write", message: "write test.txt" },
    controller.signal,
  );
  conversationSnapshotSchema.parse(
    makeConversationSnapshot({
      sessionId: "session",
      logEpoch: "test",
      seq: 1,
      revision: 1,
      ...bridge.snapshot("session"),
    }),
  );
  controller.abort();
  assert.deepEqual(await waiting, { cancelled: true });
  assert.equal(bridge.snapshot("session").pendingInteractions.length, 0);
  await bridge.close();
});

test("only the known workflow confirmation delegates to script approval", async () => {
  const { delegatesWorkflowApproval, workflowToolName } =
    await import("../src/workflow/catalog.mjs");
  assert.equal(
    delegatesWorkflowApproval({
      method: "confirm",
      title: "Approve step_workflows__step_workflows__CreateWorkflow [12345678]",
    }),
    true,
  );
  assert.equal(
    delegatesWorkflowApproval({
      method: "confirm",
      title: "Dangerous step_workflows__step_workflows__CreateWorkflow [12345678]",
    }),
    false,
  );
  assert.equal(
    delegatesWorkflowApproval({ method: "confirm", title: "Approve bash [12345678]" }),
    false,
  );
  assert.equal(workflowToolName("unrelated__CreateWorkflow"), "unrelated__CreateWorkflow");
});

test("saved workflow catalog uses strict UI shapes and durable run history", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-catalog-"));
  const { createSavedWorkflowCatalog } = await import("../src/workflow/saved.mjs");
  const schemas = await import("@zcode/shared");
  const bridge = createWorkflowBridge({
    root,
    command: [],
    rows: () => [],
    changed() {},
    completed() {},
    session: (id) =>
      id === "catalog-session"
        ? {
            workspace: { workspacePath: root },
            modelSelection: { providerId: "mock", modelId: "mock" },
          }
        : null,
  });
  try {
    const service = await bridge.service("catalog-session");
    await service.save({ name: "catalog-check", script: "return {ok:true};" });
    const catalog = createSavedWorkflowCatalog(root, root);
    schemas.zcodeWorkflowsListResultSchema.parse(catalog.list());
    schemas.zcodeWorkflowsGetResultSchema.parse(catalog.get({ name: "catalog-check" }));
    schemas.zcodeWorkflowsUpdateMetaResultSchema.parse(
      catalog.update({ name: "catalog-check", meta: { description: "Updated" } }),
    );
    const prepared = await service.prepare({ saved: { name: "catalog-check" } });
    const run = await service.launch(prepared, "catalog-tool");
    await service.active.get(run.runId)?.promise;
    const history = await bridge.savedRuns({
      workspace: { workspacePath: root },
      name: "catalog-check",
    });
    schemas.zcodeWorkflowsRunsResultSchema.parse(history);
    assert.equal(history.runs.length, 1);
    schemas.zcodeWorkflowsDeleteResultSchema.parse(await catalog.delete({ name: "catalog-check" }));
    assert.equal(catalog.list().workflows.length, 0);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
