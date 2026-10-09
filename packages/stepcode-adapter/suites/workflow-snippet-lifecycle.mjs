import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createWorkflowBridge } from "../src/workflow/bridge.mjs";
import { StepStreamProjection } from "../src/stream-projection.mjs";
import { createConversationStore } from "../src/bridge/conversation-store.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startEmbeddedBrowserRelay } from "../src/embedded-browser-relay.mjs";

async function fixture(t, mode, timeoutMs = 3000) {
  const root = await mkdtemp("D:/Temp/snippet-lifecycle-");
  const input = { code: 'return await world.run("node", ["-e", "console.log(123)"]);', timeoutMs };
  const rows = [{ rowId: 1, kind: "toolCall", toolCallId: "call", toolName: "EvalWorkflowSnippet", status: "running", input }];
  const bridge = createWorkflowBridge({ root, command: [], session: () => ({ mode, workspace: { workspacePath: root }, modelSelection: { providerId: "fixture", modelId: "fixture" } }), rows: () => rows, changed() {}, completed() {} });
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, input, bridge, rows, request: () => bridge.request({ method: "EvalWorkflowSnippet", params: input }, { sessionId: "owner" }) };
}
async function pending(bridge) {
  for (let i = 0; i < 100; i++) {
    const item = bridge.snapshot("owner").pendingInteractions[0];
    if (item) return item;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail("permission missing");
}
test("snippet full access uses session grant without an invisible second approval", { timeout: 10000 }, async t => {
  const f = await fixture(t, "yolo");
  const result = await Promise.race([f.request(), new Promise(r => setTimeout(() => r({ stalled: true }), 4000))]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.artifact.stdout.trim(), "123");
  assert.equal(f.bridge.snapshot("owner").pendingInteractions.length, 0);
});
test("snippet confirmation deadline clears pending and returns without execution", { timeout: 10000 }, async t => {
  const f = await fixture(t, "build", 150);
  const result = await Promise.race([f.request(), new Promise(r => setTimeout(() => r({ stalled: true }), 2000))]);
  assert.equal(result.stalled, undefined);
  assert.equal(result.ok, false);
  assert.equal(f.bridge.snapshot("owner").pendingInteractions.length, 0);
  assert.equal(f.rows[0].interactionId, undefined);
});
test("timed out tool rejects stale approval and cannot return to running", async t => {
  const f = await fixture(t, "build");
  const promise = f.request();
  const item = await pending(f.bridge);
  f.rows[0].status = "error";
  f.rows[0].error = { code: "step_tool_error", message: "MCP timed out" };
  f.bridge.observeTools("owner");
  assert.throws(() => f.bridge.resolve("owner", item.interactionId, { optionId: "allow" }));
  assert.equal((await promise).ok, false);
  assert.equal(f.rows[0].status, "error");
});
test("stop while awaiting snippet permission clears row and settles", async t => {
  const f = await fixture(t, "build");
  const promise = f.request(); await pending(f.bridge);
  f.bridge.cancelPending("owner");
  assert.equal((await promise).ok, false);
  assert.equal(f.rows[0].interactionId, undefined);
  assert.equal(f.rows[0].status, "cancelled");
});

test("normal mode approval executes; plan mode never executes", async t => {
  const f = await fixture(t, "build");
  const result = f.request(), item = await pending(f.bridge);
  f.bridge.resolve("owner", item.interactionId, { optionId: "allow" });
  assert.equal((await result).artifact.stdout.trim(), "123");
  const plan = await fixture(t, "plan");
  assert.equal((await plan.request()).executed, false);
  assert.equal(plan.bridge.snapshot("owner").pendingInteractions.length, 0);
});

test("terminal event revokes pending permission without reviving failed row", async t => {
  const f = await fixture(t, "build");
  const result = f.request(); await pending(f.bridge);
  const projection = new StepStreamProjection(f.rows, "turn", "fixture");
  projection.tools.set("call", f.rows[0]);
  projection.handle({ type: "tool_execution_end", toolCallId: "call", isError: true, result: "MCP timeout" });
  f.bridge.observeTools("owner");
  assert.equal((await result).executed, false);
  assert.equal(f.rows[0].status, "error");
  assert.equal(f.bridge.snapshot("owner").pendingInteractions.length, 0);
});

test("cold worker repairs orphan history but router and live owner preserve running state", async t => {
  const root = await mkdtemp("D:/Temp/cold-history-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { STATE_DIR: root, IS_SESSION_WORKER: true };
  const store = createConversationStore(ctx);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "conversations"));
  const saved = { session: { sessionId: "owner" }, rows: [
    { kind: "turnHeader", turnId: "old", state: "running", startedAt: 10, createdAt: 10 },
    { kind: "toolCall", turnId: "old", status: "running", error: { message: "timeout" }, createdAt: 20 },
    { kind: "toolCall", turnId: "old", status: "pendingApproval", interactionId: "orphan", createdAt: 30 },
  ] };
  await writeFile(store.conversationFile("owner"), JSON.stringify(saved));
  const cold = store.readConversation("owner");
  assert.equal(cold.rows[0].state, "completedInterrupted");
  assert.equal(cold.rows[0].endedAt, 30);
  assert.equal(cold.rows[1].status, "error");
  assert.equal(cold.rows[2].status, "cancelled");
  assert.equal(cold.rows[2].interactionId, undefined);
  ctx.IS_SESSION_WORKER = false;
  assert.equal(store.readConversation("owner").rows[0].state, "running");
  ctx.IS_SESSION_WORKER = true; ctx.primarySession = saved.session;
  assert.equal(store.readConversation("owner").rows[0].state, "running");
  ctx.primarySession = null; saved.session.readOnly = true;
  await writeFile(store.conversationFile("owner"), JSON.stringify(saved));
  assert.equal(store.readConversation("owner").rows[0].state, "running");
});

test("MCP cancellation disconnects HTTP and clears the actual confirmation waiter", { timeout: 10000 }, async t => {
  const f = await fixture(t, "build", 30000);
  const relay = await startEmbeddedBrowserRelay({
    directory: f.root, getContext: () => ({ sessionId: "owner" }),
    requestHost: async () => { throw new Error("unused"); },
    workflowRequest: (command, context) => f.bridge.request(command, context),
  });
  await relay.bindPid(process.pid);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/workflow-mcp.mjs", import.meta.url)), "--bridge-dir", f.root], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const reader = createInterface({ input: child.stdout });
  t.after(async () => { reader.close(); const exit = once(child, "exit"); child.kill(); await exit; await relay.close(); });
  const response = once(reader, "line");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "EvalWorkflowSnippet", arguments: f.input } }) + "\n");
  await pending(f.bridge);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) + "\n");
  assert.equal(JSON.parse((await response)[0]).result.isError, true);
  for (let i = 0; i < 100 && f.bridge.snapshot("owner").pendingInteractions.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.bridge.snapshot("owner").pendingInteractions.length, 0);
  assert.equal(f.rows[0].status, "cancelled");
});
