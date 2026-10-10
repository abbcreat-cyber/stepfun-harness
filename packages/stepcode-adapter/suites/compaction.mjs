import { test } from "node:test";
import assert from "node:assert/strict";
import { InputLedger } from "../src/input-admission.mjs";
import { createManagedQueue } from "../src/bridge/managed-queue.mjs";
import { createCompaction } from "../src/bridge/compaction.mjs";
import { settleInterruptedHistory } from "../src/bridge/interrupted-history.mjs";

function fixture() {
  let finish;
  const sent = [], promise = new Promise(resolve => { finish = resolve; });
  const selection = { providerId: "mock", modelId: "mock-mini" };
  const ctx = { ledger: new InputLedger(), turnBusy: false, conversationRows: [], primarySession: { sessionId: "compact", modelSelection: selection },
    persistConversation() {}, broadcastConversationSnapshot() {}, persistPrimarySummary() {}, broadcastSessionsIndexUpsert() {},
    nextRowId() { return this.conversationRows.length + 1; },
    preparePrompt: async () => {}, discardPreparedPrompt: async () => {}, hydrateStatistics: async () => {},
    attachmentStore: { prepare: async (_id, _files, text) => ({ images: [], text }) },
    client: { request: async command => { assert.equal(command.type, "compact"); return promise; }, getState: async () => ({}),
      prompt: async text => { sent.push(text); }, abort: async () => finish({ success: false, error: "Compaction cancelled" }) },
  };
  ctx.runWithPreparedClient = async (_options, operation) => operation(ctx.client);
  Object.assign(ctx, createManagedQueue(ctx), createCompaction(ctx));
  return { ctx, finish, sent };
}
const flush = ctx => ctx.runInputOperation(async () => {});

test("compact admission releases input lock, deduplicates and drains ordinary input after completion", async () => {
  const { ctx, finish, sent } = fixture();
  ctx.admitCompact("compact-1"); await flush(ctx);
  assert.ok(ctx.activeCompaction); assert.equal(ctx.turnBusy, true);
  assert.equal(ctx.conversationRows[0].state, "running");
  assert.equal(ctx.admitCompact("compact-2").duplicate, true);
  const entry = ctx.ledger.begin({ commandId: "next", text: "NEXT", busy: true, modelSelection: ctx.primarySession.modelSelection });
  entry.managed = true; ctx.ledger.markQueued("next");
  assert.deepEqual(sent, []);
  const done = ctx.activeCompaction.done;
  finish({ success: true, data: { summary: "SUMMARY", tokensBefore: 20000, estimatedTokensAfter: 3000 } });
  await done; await flush(ctx);
  assert.deepEqual(sent, ["NEXT"]);
  assert.equal(ctx.conversationRows[0].executionKind, "controlOnly");
  assert.notEqual(ctx.conversationRows[0].rowId, ctx.conversationRows[1].rowId);
  assert.deepEqual(ctx.conversationRows[1].marker, { type: "compact", origin: "manual", status: "success", tokensBefore: 20000, tokensAfter: 3000 });
});

test("busy and paused compact remains in the existing queue; stop cancels without sending following input", async () => {
  const { ctx, sent } = fixture(); ctx.turnBusy = true;
  const entry = ctx.admitCompact("compact-busy"); await flush(ctx); assert.equal(ctx.activeCompaction, undefined);
  assert.equal(entry.decision.delivery, "queue"); ctx.turnBusy = false; ctx.ledger.holdAll("manual");
  ctx.scheduleQueueDrain(); await flush(ctx); assert.equal(ctx.activeCompaction, undefined);
  await ctx.manageQueue({ sessionId: "compact", type: "setAutoDrain", payload: { autoDrain: true } }); await flush(ctx);
  assert.ok(ctx.activeCompaction);
  await ctx.stopCurrentTurn();
  assert.equal(ctx.turnBusy, false); assert.equal(ctx.ledger.frozen, true);
  assert.equal(ctx.conversationRows[1].marker.status, "cancelled"); assert.deepEqual(sent, []);
});

for (const [error, status] of [["Nothing to compact (session too small)", "noop"], ["WIRE_HTTP_503", "failed"]]) {
  test(`native compact failure is represented as ${status}`, async () => {
    const { ctx, finish } = fixture(); ctx.admitCompact("failure"); await flush(ctx);
    const done = ctx.activeCompaction.done; finish({ success: false, error }); await done;
    assert.equal(ctx.conversationRows[1].marker.status, status); assert.equal(ctx.turnBusy, false);
    assert.equal(ctx.ledger.frozen, status === "failed");
  });
}

test("restart settles a manual compaction marker instead of leaving a running spinner", () => {
  const saved = { session: {}, rows: [{ kind: "turnHeader", turnId: "t", state: "running", createdAt: 1, startedAt: 1 }, { kind: "timelineMarker", turnId: "t", createdAt: 2, marker: { type: "compact", status: "running" } }] };
  settleInterruptedHistory(saved);
  assert.equal(saved.rows[0].state, "completedInterrupted"); assert.equal(saved.rows[1].marker.status, "cancelled");
});

test("failed abort does not falsely mark a successfully completed compaction as cancelled", async () => {
  const { ctx, finish } = fixture(); ctx.admitCompact("abort-fault"); await flush(ctx);
  const done = ctx.activeCompaction.done;
  ctx.client.abort = async () => { throw new Error("ABORT_REJECTED"); };
  await assert.rejects(ctx.stopCurrentTurn(), /ABORT_REJECTED/);
  assert.equal(ctx.conversationRows[1].marker.status, "running");
  finish({ success: true, data: {} }); await done;
  assert.equal(ctx.conversationRows[1].marker.status, "success");
});

test("uncertain RPC timeout stops the native client before releasing the compaction slot", async () => {
  const { ctx } = fixture(); let stopped = false;
  ctx.client.request = async () => { throw Object.assign(new Error("timeout"), { stepTimeout: true }); };
  ctx.client.stop = async () => { stopped = true; };
  ctx.client.isRunning = () => !stopped;
  ctx.admitCompact("timeout"); await flush(ctx); await flush(ctx);
  assert.equal(stopped, true); assert.equal(ctx.client, null);
  assert.equal(ctx.turnBusy, false); assert.equal(ctx.conversationRows[1].marker.status, "failed");
});

test("shutdown never dispatches queued maintenance work", async () => {
  const { ctx } = fixture(); ctx.shuttingDown = true;
  const entry = ctx.admitCompact("shutdown"); await flush(ctx);
  assert.equal(entry.state, "queued"); assert.equal(ctx.activeCompaction, undefined);
});

test("startup publication failure releases the maintenance slot without calling the model", async () => {
  const { ctx } = fixture(); let saves = 0, requests = 0;
  ctx.persistConversation = () => { if (++saves === 2) throw new Error("DISK_WRITE_FAILED"); };
  ctx.client.request = async () => { requests++; return { success: true }; };
  ctx.admitCompact("disk-failure"); await flush(ctx); await flush(ctx);
  assert.equal(requests, 0); assert.equal(ctx.turnBusy, false);
  assert.equal(ctx.conversationRows[1].marker.status, "failed");
});
