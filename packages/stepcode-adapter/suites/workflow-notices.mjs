import { test } from "node:test";
import assert from "node:assert/strict";
import { InputLedger } from "../src/input-admission.mjs";
import { createClientRuntime } from "../src/bridge/client-runtime.mjs";
import { createSessionLifecycle } from "../src/bridge/session-lifecycle.mjs";
import { createManagedQueue } from "../src/bridge/managed-queue.mjs";
import { isWorkflowNoticeCurrent } from "../src/bridge/workflow-notices.mjs";

// 使用真实通知准入和队列实现；底座 prompt 是记录发送次数的边界替身。
async function fixture() {
  const selection = { providerId: "mock", modelId: "mock-mini" };
  const ctx = {
    options: { communicationMode: "mock" }, STATE_DIR: ".",
    primarySession: { sessionId: "runtime", modelSelection: selection },
    turnBusy: false, conversationRows: [], ledger: new InputLedger(),
    attachmentStore: { prepare: async (_id, _files, text) => ({ images: [], text }) },
    persistConversation() {}, broadcastConversationSnapshot() {},
    hydrateStatistics: async () => {},
    client: { isRunning: () => true, getState: async () => ({ model: { provider: "mock", id: "mock-mini" } }), prompt: async () => {} },
  };
  Object.assign(ctx, createClientRuntime(ctx), createSessionLifecycle(ctx), createManagedQueue(ctx));
  ctx.runWithPreparedClient = async (_options, operation) => operation(ctx.client);
  ctx.preparePrompt = async () => {};
  return { ctx };
}

test("prepared: answered workflow questions never trigger a stale queued model turn", async t => {
  const { ctx } = await fixture(t);
  assert.equal(await ctx.workflowBridge.isQuestionPending("runtime", { runId: "old-run", questionId: "old-question" }), false);
  let pending = true;
  t.mock.method(ctx.workflowBridge, "isQuestionPending", async () => pending);
  const sent = [];
  t.mock.method(ctx.client, "prompt", async text => { sent.push(text); });
  const notice = { runId: "workflow", status: "waiting_question", question_id: "dwfq-1" };
  ctx.turnBusy = true;
  const entry = await ctx.notifyWorkflowCompletion("runtime", notice);
  assert.deepEqual(entry.workflowNotice, { runId: "workflow", status: "waiting_question", questionId: "dwfq-1" });
  const restored = new InputLedger(); restored.restoreQueue(ctx.ledger.serializeQueue());
  assert.deepEqual(restored.managedQueued()[0].workflowNotice, entry.workflowNotice);
  await ctx.admitAndSend({ commandId: "user-after-question", text: "用户下一项" });
  pending = false;
  assert.equal(await ctx.notifyWorkflowCompletion("runtime", notice), undefined);
  ctx.turnBusy = false;
  ctx.scheduleQueueDrain(); await ctx.runInputOperation(async () => {}); await ctx.runInputOperation(async () => {});
  assert.equal(entry.state, "cancelled");
  assert.deepEqual(sent, ["用户下一项"]);
});

test("prepared: already observed workflow completion does not create another model turn", async t => {
  const { ctx } = await fixture(t), sent = [];
  t.mock.method(ctx.client, "prompt", async text => { sent.push(text); });
  ctx.turnBusy = true;
  const notice = { runId: "workflow", status: "completed" };
  const entry = await ctx.notifyWorkflowCompletion("runtime", notice);
  const receipt = { kind: "toolCall", toolName: "GetWorkflowRun", status: "success", input: { runId: "workflow" }, output: { text: JSON.stringify({ run: notice }) } };
  for (const altered of [{ ...receipt, status: "running" }, { ...receipt, input: { runId: "different" } }, { ...receipt, kind: "assistantText" }, { ...receipt, output: { text: "invalid" } }]) {
    assert.equal(await isWorkflowNoticeCurrent({ conversationRows: [altered] }, notice), true);
  }
  ctx.conversationRows.push(receipt);
  assert.equal(await ctx.notifyWorkflowCompletion("runtime", notice), undefined);
  ctx.turnBusy = false; ctx.scheduleQueueDrain(); await ctx.runInputOperation(async () => {});
  assert.equal(entry.state, "cancelled"); assert.deepEqual(sent, []);
  assert.equal(await isWorkflowNoticeCurrent(ctx, { ...notice, status: "errored" }), true);
});

test("prepared: unanswered workflow questions still reach the model", async t => {
  const { ctx } = await fixture(t);
  t.mock.method(ctx.workflowBridge, "isQuestionPending", async () => true);
  const sent = [];
  t.mock.method(ctx.client, "prompt", async text => { sent.push(text); });
  ctx.turnBusy = true;
  await ctx.notifyWorkflowCompletion("runtime", { runId: "workflow", status: "waiting_question", question_id: "dwfq-live" });
  ctx.turnBusy = false;
  ctx.scheduleQueueDrain(); await ctx.runInputOperation(async () => {});
  assert.equal(sent.length, 1); assert.match(sent[0], /dwfq-live/);
});
