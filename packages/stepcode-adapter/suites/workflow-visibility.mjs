import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkflowBridge } from "../src/workflow/bridge.mjs";
import { StepWorkflowService } from "../src/workflow/service.mjs";
import { SessionRouter } from "../src/session-router.mjs";
import { makeConversationSnapshot } from "../src/wire-shapes.mjs";
import { WorkflowToolAdmission } from "../src/workflow/tool-admission.mjs";
import { launchBridge } from "./zcode-bridge-launch.mjs";
import { waitForExit } from "./helpers.mjs";
const { conversationSnapshotSchema } = await import("@zcode/shared/zcode-protocol-v4");

test("closing admission rejects a pending request and clears its deadline", async () => {
  const admission = new WorkflowToolAdmission(
    () => [],
    (name) => name,
    1000,
  );
  const waiting = admission.claim("parent", "CreateWorkflow", { script: "return 1;" });
  admission.cancel("other");
  assert.equal(admission.waiters.size, 1);
  admission.cancel("parent");
  await assert.rejects(waiting, /已取消/);
  assert.equal(admission.waiters.size, 0);
});

test("MCP admission waits for the matching stdio tool event and claims it only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-workflow-admission-"));
  const rows = [];
  const bridge = createWorkflowBridge({
    root,
    command: [],
    rows: () => rows,
    changed() {},
    completed() {},
    session: () => ({
      workspace: { workspacePath: root },
      modelSelection: { providerId: "mock", modelId: "mock" },
    }),
    toolAdmissionTimeoutMs: 150,
  });
  try {
    await bridge.request({ method: "ReadWorkflowGuide" }, { sessionId: "parent" });
    await bridge.service("parent");
    const params = { name: "large-script", max_concurrency: 4, script: "return !!!;" };
    const pending = bridge
      .request({ method: "CreateWorkflow", params }, { sessionId: "parent" })
      .catch((error) => ({ error: error.message }));
    await new Promise((resolve) => setTimeout(resolve, 15));
    rows.push({
      rowId: 1,
      kind: "toolCall",
      toolCallId: "call-late",
      toolName: "CreateWorkflow",
      status: "running",
      input: { script: params.script, name: params.name, max_concurrency: 4 },
    });
    bridge.observeTools?.("parent");
    const result = await pending;
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(result.display?.diagnostics.length > 0, "应接到真实编译诊断，而不是关联失败");
    await assert.rejects(
      bridge.request({ method: "CreateWorkflow", params }, { sessionId: "parent" }),
      /没有匹配/,
    );
    await assert.rejects(
      bridge.request(
        { method: "CreateWorkflow", params: { ...params, script: "return 123;" } },
        { sessionId: "other" },
      ),
      /没有匹配/,
    );
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatched actors expose their actual session id and durable read-only transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-workflow-visible-"));
  const service = new StepWorkflowService({
    communicationMode: "mock",
    root,
    cwd: root,
    conversationRoot: join(root, "conversations"),
    sessionId: "parent",
    model: { providerId: "step", modelId: "step-5-preview" },
    command: [
      process.execPath,
      fileURLToPath(new URL("../mock/step-rpc-mock.mjs", import.meta.url)),
    ],
    confirm: async () => ({ approved: true }),
  });
  try {
    await service.guide();
    const created = await service.create(
      { script: 'const worker=agent("visible-worker");return await worker.ask("可见性验收");' },
      "visible-call",
    );
    await service.active.get(created.runId)?.promise;
    const detail = service.detail(created.runId),
      state = service.refresh();
    assert.equal(detail.run.status, "completed", JSON.stringify(detail.run.failure));
    assert.equal(
      state.runs[0].actors[0].sessionId,
      detail.actors[0].sessionId,
      "不能把已派发 actor 投影成未启动",
    );
    const saved = JSON.parse(
      await readFile(
        join(root, "conversations", encodeURIComponent(detail.actors[0].sessionId) + ".json"),
        "utf8",
      ),
    );
    assert.equal(saved.session.workflowParentSessionId, "parent");
    assert.equal(saved.session.readOnly, true);
    assert.ok(saved.rows.some((row) => row.kind === "userInput"));
    assert.ok(saved.rows.some((row) => row.kind === "assistantText" && row.text));
    conversationSnapshotSchema.parse(
      makeConversationSnapshot({
        sessionId: saved.session.sessionId,
        logEpoch: "test",
        seq: 1,
        revision: 1,
        rows: saved.rows,
        usage: new (await import("../src/session-statistics.mjs")).SessionStatistics(
          saved.statistics,
        ).usage(),
      }),
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor reads reuse the parent owner and commands cannot replace or stop the parent", async () => {
  const answers = [],
    calls = [];
  const router = new SessionRouter({ args: [], write: (frame) => answers.push(frame) });
  const parent = { key: "parent", subscriptionDetails: new Map(), subscriptions: new Set() };
  router.workers.set("parent", parent);
  router.worker = (key) => {
    calls.push(key);
    return router.workers.get(key) || { key };
  };
  router.send = (worker, method, params, finish) => {
    calls.push({ key: worker.key, method, params });
    finish({ result: {} });
  };
  try {
    router.rememberActorOwners?.(parent, {
      sessionId: "parent",
      workflowRuns: { runs: [{ actors: [{ sessionId: "actor-real" }] }] },
    });
    router.route({
      id: "read",
      method: "v4/conversation/subscribe",
      params: { topic: "conversation/actor-real", connectionId: "test" },
    });
    assert.equal(calls.at(-1).key, "parent");
    for (const method of ["session/send", "session/load", "session/stop", "v4/command"]) {
      const before = calls.length;
      router.receive({
        id: method,
        method,
        params: { sessionId: "actor-real", type: "stop", commandId: method },
      });
      assert.equal(calls.length, before);
      assert.match(answers.at(-1).error.message, /只读/);
    }
  } finally {
    clearInterval(router.reaper);
  }
});

test("cold actor topics remain read-only before any parent snapshot has reached the router", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-workflow-cold-"));
  const id = "cold-actor",
    rows = [
      { rowId: 1, kind: "assistantText", text: "COLD_OK", state: "complete", turnId: "cold" },
    ];
  await mkdir(join(root, "conversations"), { recursive: true });
  await writeFile(
    join(root, "conversations", id + ".json"),
    JSON.stringify({
      session: {
        sessionId: id,
        workspace: { workspacePath: root },
        readOnly: true,
        workflowParentSessionId: "parent",
      },
      rows,
    }),
  );
  const bridge = launchBridge(["--state-dir", root]);
  try {
    bridge.send({
      id: 1,
      method: "v4/conversation/subscribe",
      params: {
        topic: "conversation/" + id,
        connectionId: "cold",
        clientMode: "web-remote-replayable",
      },
    });
    await bridge.waitFor((frame) => frame.id === 1);
    const frame = await bridge.waitFor(
      (frame) => frame.params?.frame?.payload?.snapshot?.sessionId === id,
    );
    assert.equal(frame.params.frame.payload.snapshot.rows.window[0].text, "COLD_OK");
    assert.equal(frame.params.frame.payload.snapshot.control.canStop, false);
    for (const [index, method] of ["session/send", "session/stop", "v4/command"].entries()) {
      bridge.send({
        id: index + 10,
        method,
        params: {
          sessionId: id,
          type: "sendText",
          content: "must not send",
          commandId: "readonly-" + index,
        },
      });
      const reply = await bridge.waitFor((frame) => frame.id === index + 10);
      assert.match(reply.error?.message || "", /只读/);
    }
  } finally {
    bridge.child.stdin.end();
    await waitForExit(bridge.child);
    await rm(root, { recursive: true, force: true });
  }
});

test("actor history is rebuilt from the native ledger without executing the workflow again", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-workflow-replay-"));
  const options = {
    communicationMode: "mock",
    root,
    cwd: root,
    conversationRoot: join(root, "conversations"),
    sessionId: "parent",
    model: { providerId: "step", modelId: "step-5-preview" },
    command: [
      process.execPath,
      fileURLToPath(new URL("../mock/step-rpc-mock.mjs", import.meta.url)),
    ],
    confirm: async () => ({ approved: true }),
  };
  let service = new StepWorkflowService(options);
  try {
    await service.guide();
    const created = await service.create(
      { script: 'const a=agent("history");return await a.ask("history");' },
      "history-call",
    );
    await service.active.get(created.runId)?.promise;
    const actor = service.detail(created.runId).actors[0];
    const file = join(root, "conversations", encodeURIComponent(actor.sessionId) + ".json");
    const native = join(root, "native-history.jsonl");
    await writeFile(
      native,
      [
        { type: "session", id: "native", cwd: root },
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "history question" }] },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            model: "step-5-preview",
            stopReason: "stop",
            content: [{ type: "text", text: "REPLAY_OK" }],
          },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n"),
    );
    await writeFile(
      join(root, "actors", encodeURIComponent(actor.sessionId) + ".json"),
      JSON.stringify({ sessionFile: native }),
    );
    await service.close();
    await rm(file);
    service = new StepWorkflowService({ ...options, command: ["must-not-spawn-a-client"] });
    await service.recover();
    const recovered = JSON.parse(await readFile(file, "utf8"));
    assert.ok(
      recovered.rows.some((row) => row.kind === "assistantText" && row.text === "REPLAY_OK"),
    );
    assert.equal(service.active.size, 0);
    assert.equal(service.refresh().runs[0].actors[0].sessionId, actor.sessionId);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
