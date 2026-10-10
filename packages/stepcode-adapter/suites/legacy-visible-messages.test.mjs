import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyVisibleMessages } from "../src/legacy-visible-messages.mjs";
import { makeSessionStateSnapshot } from "../src/wire-shapes.mjs";
import { launchBridge } from "./helpers.mjs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { zcodeSessionStateSnapshotSchema } = await import("@zcode/shared");
const session = { sessionId: "search", workspace: { workspacePath: "D:/qa" } };
const rows = [
  { kind: "userInput", rowId: 1, turnId: "t", origin: "realUser", text: "用户搜索词", createdAt: 1 },
  { kind: "reasoning", rowId: 2, turnId: "t", text: "不能索引的思考", createdAt: 2 },
  { kind: "assistantText", rowId: 3, turnId: "t", text: "过程说明", createdAt: 3 },
  { kind: "toolCall", rowId: 4, turnId: "t", text: "工具内部正文", createdAt: 4 },
  { kind: "assistantText", rowId: 5, turnId: "t", text: "最终检索正文", createdAt: 5 },
  { kind: "userInput", rowId: 6, turnId: "internal", origin: "backgroundResult", text: "隐藏提醒", createdAt: 6 },
];
test("兼容快照可索引当前分支可见正文，并通过真实协议校验", () => {
  const messages = legacyVisibleMessages(session, rows);
  assert.deepEqual(messages.map(m => m.parts[0].text), ["用户搜索词", "最终检索正文"]);
  const snapshot = makeSessionStateSnapshot(session); snapshot.messages = messages;
  zcodeSessionStateSnapshotSchema.parse(snapshot);
  assert.equal(messages[1].info.parentMessageId, messages[0].info.messageId);
});
test("分支改写不会带回旧正文，长文本有界", () => {
  assert.equal(legacyVisibleMessages(session, [{ ...rows[0], text: "新的分支" }])[0].parts[0].text, "新的分支");
  assert.equal(legacyVisibleMessages(session, [{ ...rows[0], text: "x".repeat(200100) }])[0].parts[0].text.length, 200000);
});

test("桥接 session/read 实际返回可索引正文，而不是只有标题", async () => {
  const base = process.env.STEP_TEST_ROOT || join(tmpdir(), "stepcode-search-tests");
  await mkdir(base, { recursive: true }); const root = await mkdtemp(base + "/read-");
  const bridge = launchBridge([], {}, { stateDir: root, cwd: root });
  try {
    bridge.send({ id: 1, method: "session/create", params: { workspace: { workspacePath: root } } });
    const created = await bridge.waitFor(f => f.id === 1);
    const sessionId = created.result.session.sessionId;
    bridge.send({ id: 2, method: "session/send", params: { sessionId, content: "BODY_SEARCH_BOUNDARY_672" } });
    await bridge.waitFor(f => f.method === "session/event" && f.params.type === "turn.completed");
    bridge.send({ id: 3, method: "session/read", params: { sessionId } });
    const response = await bridge.waitFor(f => f.id === 3);
    const snapshot = zcodeSessionStateSnapshotSchema.parse(response.result);
    assert.ok(snapshot.messages.some(m => m.info.role === "user" && m.parts.some(p => p.text === "BODY_SEARCH_BOUNDARY_672")));
    assert.ok(snapshot.messages.some(m => m.info.role === "assistant"));
    for (const [index, method] of ["session/resume", "session/setModel", "session/setThoughtLevel"].entries()) {
      const id = 4 + index;
      bridge.send({ id, method, params: { sessionId, model: { providerId: "step", modelId: "step-5-preview" }, thoughtLevel: "medium" } });
      const next = await bridge.waitFor(f => f.id === id);
      assert.ok(!next.error, JSON.stringify({ method, error: next.error }));
      const parsed = zcodeSessionStateSnapshotSchema.parse(next.result);
      assert.ok(parsed.messages.some(m => m.parts.some(p => p.text === "BODY_SEARCH_BOUNDARY_672")), method);
      assert.equal(parsed.session.createdAt, snapshot.session.createdAt);
    }
  } finally { bridge.child.stdin.end(); }
});
