import test from "node:test";
import assert from "node:assert/strict";
import { InputLedger } from "../src/input-admission.mjs";
import { createManagedQueue } from "../src/bridge/managed-queue.mjs";

function fixture(code) {
  let fail = Boolean(code),
    prompts = 0,
    promptError;
  const frames = [],
    ledger = new InputLedger();
  const entry = ledger.begin({ commandId: "queued", text: "test", busy: true });
  entry.managed = true;
  ledger.markQueued(entry.commandId);
  const client = {
    getState: async () => ({}),
    prompt: async () => {
      prompts++;
      if (promptError) throw promptError;
    },
  };
  const ctx = {
    primarySession: { sessionId: "s" },
    ledger,
    turnBusy: false,
    persistConversation() {
      if (fail) throw Object.assign(Error("save failed"), { code });
    },
    broadcastConversationSnapshot() {
      frames.push({ state: entry.state, frozen: ledger.frozen, reason: ledger.pauseReason });
    },
    attachmentStore: { prepare: async () => ({ images: [], text: "test" }) },
    runWithPreparedClient: async (_options, fn) => fn(client),
    hydrateStatistics: async () => {},
    preparePrompt: async () => {},
    discardPreparedPrompt: async () => {},
  };
  Object.assign(ctx, createManagedQueue(ctx));
  return {
    ctx,
    entry,
    frames,
    prompts: () => prompts,
    unlock() {
      fail = false;
    },
    timeout() {
      promptError = Object.assign(Error("uncertain"), { stepTimeout: true });
    },
    async drain() {
      ctx.scheduleQueueDrain();
      await ctx.runInputOperation(async () => {});
    },
  };
}
for (const code of ["EBUSY", "ENOSPC"])
  test(`首次保存 ${code} 不留假 submitted，恢复后只发送一次`, async () => {
    const f = fixture(code);
    await f.drain();
    assert.equal(f.prompts(), 0);
    assert.equal(f.entry.state, "queued");
    assert.equal(f.ctx.ledger.frozen, true);
    assert.equal(f.ctx.ledger.pauseReason, "error");
    assert.deepEqual(f.frames.at(-1), { state: "queued", frozen: true, reason: "error" });
    f.unlock();
    await f.ctx.manageQueue({ type: "setAutoDrain", sessionId: "s", payload: { autoDrain: true } });
    await f.ctx.runInputOperation(async () => {});
    assert.equal(f.prompts(), 1);
    assert.equal(f.entry.state, "submitted");
    await f.drain();
    assert.equal(f.prompts(), 1);
  });
test("投递超时仍保留 submitted，恢复不会自动重发", async () => {
  const f = fixture();
  f.timeout();
  await f.drain();
  assert.equal(f.prompts(), 1);
  assert.equal(f.entry.state, "submitted");
  assert.equal(f.ctx.ledger.frozen, true);
  f.ctx.turnBusy = false;
  f.ctx.ledger.resume();
  await f.drain();
  assert.equal(f.prompts(), 1);
});
