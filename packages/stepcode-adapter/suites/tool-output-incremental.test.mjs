import test from "node:test";
import assert from "node:assert/strict";
import { StepStreamProjection } from "../src/stream-projection.mjs";
import { applyConversationDeltas, conversationDeltaSchema, filterConversationDeltasForProfile, DELIVERY_PROFILES } from "@zcode/shared/zcode-protocol-v4";

const initial = () => ({ rows: { window: [], totalCount: 0, firstRowId: null } });
function fixture() {
  const rows = [], projection = new StepStreamProjection(rows, "turn", "model");
  const deltas = [];
  const send = event => { const emitted = projection.handle({ toolCallId: "tool", toolName: "powershell", ...event }); emitted.forEach(d => conversationDeltaSchema.parse(d)); deltas.push(...emitted); return emitted; };
  send({ type: "tool_execution_start", args: { command: "fixture" } });
  return { rows, deltas, send, update: (text, extra = {}) => send({ type: "tool_execution_update", partialResult: { content: [{ type: "text", text }] }, ...extra }) };
}

test("运行中只追加新增输出，重复累计结果不重发", () => {
  const f = fixture();
  assert.equal(f.update("中文\n")[0].op, "row.upserted");
  assert.deepEqual(f.update("中文\n🙂next"), [{ op: "row.delta", rowId: 1, path: "output.text", append: "🙂next" }]);
  assert.deepEqual(f.update("中文\n🙂next"), []);
  assert.deepEqual(f.update("中文\n🙂next", { args: { command: "fixture" } }), []);
  assert.equal(f.rows[0].output.text, "中文\n🙂next");
  assert.deepEqual(applyConversationDeltas(initial(), f.deltas).rows.window, f.rows);
});

test("尾窗截断、清空、参数与状态变化仍发完整行", () => {
  const f = fixture(); f.update("first\nsecond\n");
  for (const [text, extra] of [["second\nthird\n", {}], ["", {}], ["new", { args: { command: "changed" } }]]) assert.equal(f.update(text, extra)[0].op, "row.upserted");
  f.rows[0].status = "pendingApproval";
  const updated = f.update("new plus"); assert.equal(updated[0].op, "row.upserted"); assert.equal(updated[0].row.status, "running");
});

test("桌面与可恢复通道终态一致，中途快照可续接，日志元数据保留", () => {
  const f = fixture(); f.update("a"); f.update("a中");
  const snapshot = { rows: { window: structuredClone(f.rows), totalCount: 1, firstRowId: 1 } }, offset = f.deltas.length;
  f.update("a中文🙂"); f.update("tail"); f.update("tail\nend");
  f.send({ type: "tool_execution_end", isError: false, result: { content: [{ type: "text", text: "tail\nend" }], details: { fullOutputPath: "D:/logs/output.txt", truncation: { truncated: true } } } });
  assert.equal(f.deltas.at(-1).op, "row.upserted");
  for (const profile of Object.values(DELIVERY_PROFILES)) assert.deepEqual(applyConversationDeltas(initial(), filterConversationDeltasForProfile(f.deltas, profile)).rows.window, f.rows);
  assert.deepEqual(applyConversationDeltas(snapshot, f.deltas.slice(offset)).rows.window, f.rows);
  assert.equal(f.rows[0].output.display.outputPath, "D:/logs/output.txt");
});

test("百次累计输出更新不再重复传输整个前缀", t => {
  const f = fixture(); let text = "", actual = 0, fullResend = 0;
  for (let i = 0; i < 100; i++) {
    text += "x".repeat(1024);
    actual += Buffer.byteLength(JSON.stringify(f.update(text)));
    fullResend += Buffer.byteLength(JSON.stringify([{ op: "row.upserted", row: f.rows[0] }]));
  }
  assert.ok(actual < fullResend / 20, `${actual} vs ${fullResend}`);
  t.diagnostic(JSON.stringify({ incrementalBytes: actual, fullRowBytes: fullResend, reductionPercent: 100 * (1 - actual / fullResend) }));
  assert.deepEqual(applyConversationDeltas(initial(), f.deltas).rows.window, f.rows);
});

test("交错运行的两个工具输出按行归属，不串行或重复追加", () => {
  const f = fixture(); f.update("one:");
  f.send({ type: "tool_execution_start", toolCallId: "second", args: { command: "second" } });
  f.send({ type: "tool_execution_update", toolCallId: "second", partialResult: { text: "two:" } });
  f.update("one:A");
  const d = f.send({ type: "tool_execution_update", toolCallId: "second", partialResult: { text: "two:B" } });
  assert.deepEqual(d, [{ op: "row.delta", rowId: 2, path: "output.text", append: "B" }]);
  assert.deepEqual(applyConversationDeltas(initial(), f.deltas).rows.window.map(r => r.output.text), ["one:A", "two:B"]);
});

test("没有工具结束回执的中断仍以完整行收口，不丢已收到的尾部输出", () => {
  const f = fixture(); f.update("begin"); f.update("begin\nlast-before-stop");
  f.send({ type: "agent_settled" });
  for (const profile of Object.values(DELIVERY_PROFILES)) {
    const row = applyConversationDeltas(initial(), filterConversationDeltasForProfile(f.deltas, profile)).rows.window[0];
    assert.equal(row.status, "cancelled"); assert.equal(row.output.text, "begin\nlast-before-stop");
  }
});
