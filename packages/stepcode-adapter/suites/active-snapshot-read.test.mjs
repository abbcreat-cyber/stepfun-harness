import test from "node:test";
import assert from "node:assert/strict";
import { createProjection } from "../src/bridge/projection.mjs";
import { InputLedger } from "../src/input-admission.mjs";
import { SessionStatistics } from "../src/session-statistics.mjs";
test("活动快照保留保存且不回读无用正文，冷/只读/其他会话继续读取", () => {
  const frames = [],
    reads = [];
  let saves = 0;
  const disk = {
    session: { sessionId: "other", readOnly: true },
    rows: [{ kind: "assistantText", rowId: 2, text: "disk", state: "complete" }],
    statistics: {},
  };
  const ctx = {
    primarySession: { sessionId: "active" },
    conversationRows: [{ kind: "assistantText", rowId: 1, text: "live", state: "complete" }],
    turnBusy: false,
    ledger: new InputLedger(),
    v4Subscriptions: new Map([
      ["conversation/active", "a"],
      ["conversation/other", "b"],
    ]),
    conversationSeq: 0,
    stateRevision: 0,
    logEpoch: "test",
    workflowBridge: { snapshot: () => ({}) },
    sessionStatistics: () => new SessionStatistics(),
    persistConversation() {
      saves++;
    },
    readConversation(id) {
      reads.push(id);
      return disk;
    },
    notify(_method, payload) {
      frames.push(payload);
    },
  };
  const p = createProjection(ctx),
    last = () => frames.at(-1).frame.payload.snapshot;
  p.broadcastConversationSnapshot();
  assert.equal(saves, 1);
  assert.deepEqual(reads, []);
  assert.equal(last().rows.window[0].text, "live");
  p.broadcastConversationSnapshot("conversation/other", "recovery");
  assert.deepEqual(reads, ["other"]);
  assert.equal(last().rows.window[0].text, "disk");
  assert.equal(frames.at(-1).deliveryKind, "recovery");
  ctx.primarySession.readOnly = true;
  p.broadcastConversationSnapshot();
  assert.deepEqual(reads, ["other", "active"]);
  assert.equal(last().rows.window[0].text, "live");
  ctx.primarySession = null;
  p.broadcastConversationSnapshot("conversation/other");
  assert.deepEqual(reads, ["other", "active", "other"]);
  assert.equal(last().rows.window[0].text, "disk");
});
