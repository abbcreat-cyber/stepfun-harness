import test from "node:test";
import assert from "node:assert/strict";
import { InputLedger } from "../src/input-admission.mjs";
import { createProjection } from "../src/bridge/projection.mjs";
import { createManagedQueue } from "../src/bridge/managed-queue.mjs";

function queued(ledger, commandId, text = commandId) {
  const e = ledger.begin({ commandId, text, busy: true }); e.managed = true; ledger.markQueued(commandId); return e;
}

test("无界面订阅仍保存排队编辑、取消、排序，恢复只保留最新内容", async () => {
  let saved;
  const ctx = { primarySession: { sessionId: "s" }, ledger: new InputLedger(), v4Subscriptions: new Map(),
    persistConversation() { saved = structuredClone(ctx.ledger.serializeQueue()); }, notify() { assert.fail("无订阅不应发送帧"); } };
  Object.assign(ctx, createProjection(ctx), createManagedQueue(ctx));
  queued(ctx.ledger, "a"); queued(ctx.ledger, "b"); queued(ctx.ledger, "c");
  await ctx.manageQueue({ sessionId: "s", type: "editQueueItem", payload: { queueItemId: "qi_b", newText: "edited" } });
  await ctx.manageQueue({ sessionId: "s", type: "deleteQueueItem", payload: { queueItemId: "qi_a" } });
  await ctx.manageQueue({ sessionId: "s", type: "reorderQueueItem", payload: { queueItemId: "qi_c", beforeQueueItemId: "qi_b" } });
  assert.ok(saved, "无订阅也必须落盘");
  const restored = new InputLedger(); restored.restoreQueue(saved);
  assert.deepEqual(restored.managedQueued().map(e => e.text), ["c", "edited"]);
  assert.equal(restored.frozen, true);
});

test("其他会话的冷订阅请求不能触发当前会话写入", () => {
  let saves = 0;
  const ctx = { primarySession: { sessionId: "current" }, v4Subscriptions: new Map(), persistConversation() { saves++; } };
  const api = createProjection(ctx); api.broadcastConversationSnapshot("conversation/other");
  assert.equal(saves, 0); api.broadcastConversationSnapshot(); assert.equal(saves, 1);
});

test("千轮完成/失败/取消的调度记录回收，不扫描整段聊天历史", () => {
  const ledger = new InputLedger();
  for (let i = 0; i < 1000; i++) {
    ledger.begin({ commandId: "ok-" + i, text: "message" }); ledger.markSubmitted("ok-" + i);
    ledger.attributeNextRun();
    ledger.begin({ commandId: "fail-" + i, text: "failed" }); ledger.markFailed("fail-" + i);
    queued(ledger, "cancel-" + i).state = "cancelled";
    ledger.settleTurn();
    assert.equal(ledger.entries.size, 0);
  }
  assert.equal(ledger.admissionSeq, 3000);
});

test("回收不丢未投递/未知投递，晚 ACK 不复活已消费输入", () => {
  const ledger = new InputLedger();
  const completed = ledger.begin({ commandId: "done", text: "done" }); ledger.attributeNextRun();
  const pending = ledger.begin({ commandId: "pending", text: "pending" });
  const uncertain = queued(ledger, "uncertain"); uncertain.state = "submitted";
  const waiting = queued(ledger, "waiting");
  ledger.settleTurn();
  ledger.markSubmitted("done"); ledger.markSteered("done");
  assert.equal(completed.state, "attributed"); assert.equal(ledger.entries.has("done"), false);
  assert.deepEqual([...ledger.entries.values()], [pending, uncertain, waiting]);
  assert.equal(ledger.queueItems().find(e => e.sourceCommandId === "uncertain").dispatch.state, "reserved");
  assert.deepEqual(ledger.managedQueued(), [waiting]);
});
