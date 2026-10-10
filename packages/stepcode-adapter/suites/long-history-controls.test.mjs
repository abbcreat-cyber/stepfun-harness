import test from "node:test";
import assert from "node:assert/strict";
import { activeEntries, createHistoryControls } from "../src/bridge/history-controls.mjs";

test("长分支不重复扫描已访问前缀，并保持对象顺序与循环校验", () => {
  const entries = Array.from({ length: 10000 }, (_, i) => ({
    id: `e${i}`,
    parentId: i ? `e${i - 1}` : null,
    historyProbe: true,
  }));
  const original = Array.prototype.includes;
  let comparisons = 0;
  Array.prototype.includes = function (value, ...rest) {
    if (value?.historyProbe) comparisons += this.length;
    return original.call(this, value, ...rest);
  };
  let actual;
  try {
    actual = activeEntries({ entries, leafId: "e9999" });
  } finally {
    Array.prototype.includes = original;
  }
  assert.equal(actual.length, entries.length);
  assert.ok(actual.every((e, i) => e === entries[i]));
  assert.ok(comparisons <= entries.length, `重复前缀比较上界 ${comparisons}`);
  assert.deepEqual(activeEntries({ entries, leafId: null }), []);
  assert.throws(
    () =>
      activeEntries({
        entries: [
          { id: "a", parentId: "b" },
          { id: "b", parentId: "a" },
        ],
        leafId: "a",
      }),
    /分支不完整/,
  );
  assert.throws(
    () => activeEntries({ entries: [{ id: "a", parentId: "a" }], leafId: "a" }),
    /分支不完整/,
  );
  assert.throws(
    () => activeEntries({ entries: [{ id: "a", parentId: "missing" }], leafId: "a" }),
    /分支不完整/,
  );
  const final = { id: "dup", parentId: null };
  assert.deepEqual(
    activeEntries({ entries: [{ id: "dup", parentId: "missing" }, final], leafId: "dup" }),
    [final],
  );
});

for (const type of ["editUserQuery", "retryAssistant"]) {
  test(`20万行 ${type} 不超过参数栈，保留行号水位与旧轮`, async () => {
    const count = 200000,
      rows = Array.from({ length: count }, (_, i) => ({
        kind: "assistantText",
        rowId: i + 1,
        turnId: "past",
        text: "old",
      }));
    const user = {
      kind: "userInput",
      origin: "realUser",
      rowId: count + 1,
      turnId: "latest",
      entityId: "user",
      text: "original",
      attachments: [],
    };
    const assistant = {
      kind: "assistantText",
      rowId: count + 2,
      turnId: "latest",
      entityId: "answer",
      text: "answer",
    };
    rows.push(user, assistant);
    const sent = [],
      requests = [];
    const ctx = {
      stateRevision: 5,
      logEpoch: "epoch",
      turnBusy: false,
      primarySession: {
        sessionId: "s",
        stepSessionFile: "old",
        rowHighWater: type === "editUserQuery" ? 999999 : 0,
      },
      conversationRows: rows,
      ledger: { managedQueued: () => [] },
      workflowBridge: { snapshot: () => ({ backgroundWorks: [] }) },
      attachmentStore: { prepare: async () => ({}) },
      restoreSession: async () => {},
      persistConversation() {},
      broadcastConversationSnapshot() {},
      admitAndSend: async (input) => sent.push(input),
      runWithPreparedClient: async (_options, fn) =>
        fn({
          request: async (p) => {
            requests.push(p);
            return p.type === "get_entries"
              ? {
                  success: true,
                  data: {
                    entries: [
                      { id: "user", parentId: null, type: "message", message: { role: "user" } },
                    ],
                    leafId: "user",
                  },
                }
              : { success: true, data: { cancelled: false } };
          },
          getState: async () => ({ sessionFile: "new" }),
        }),
    };
    const target = type === "editUserQuery" ? user : assistant;
    await createHistoryControls(ctx).historyCommand(
      {
        type,
        sessionId: "s",
        commandId: "edit",
        baseRevision: 5,
        baseLogEpoch: "epoch",
        payload: { target: { rowId: target.rowId, entityId: target.entityId }, newText: "edited" },
      },
      5,
    );
    assert.equal(ctx.primarySession.rowHighWater, type === "editUserQuery" ? 999999 : count + 2);
    assert.equal(ctx.primarySession.stepSessionFile, "new");
    assert.equal(ctx.conversationRows.length, count);
    assert.equal(ctx.conversationRows[0], rows[0]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, type === "editUserQuery" ? "edited" : "original");
    assert.equal(requests.filter((p) => p.type === "fork").length, 1);
  });
}
