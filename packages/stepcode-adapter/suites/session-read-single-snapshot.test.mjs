import test from "node:test";
import assert from "node:assert/strict";
import { createSessionMethods } from "../src/bridge/methods-session.mjs";

test("历史 session/read 使用同一次读取的元数据和正文，活动会话不读盘", () => {
  let reads = 0;
  const session = {
    sessionId: "history",
    workspace: { workspacePath: "D:/qa", workspaceKey: "qa" },
    title: "自定义名称",
    titleSource: "custom",
    createdAt: 1000,
  };
  const rows = [
    { kind: "userInput", origin: "realUser", rowId: 1, turnId: "t", text: "历史输入" },
    { kind: "assistantText", rowId: 2, turnId: "t", text: "原始回复", state: "complete" },
  ];
  const ctx = {
    primarySession: null,
    conversationRows: [],
    readConversation(id) {
      reads++;
      return id === "missing" ? null : { session, rows };
    },
  };
  const read = createSessionMethods(ctx)["session/read"];
  const result = read({ sessionId: "history" });
  assert.equal(reads, 1);
  assert.equal(result.session.title, "自定义名称");
  assert.ok(JSON.stringify(result.messages).includes("原始回复"));
  reads = 0;
  ctx.primarySession = session;
  ctx.conversationRows = rows;
  const active = read({ sessionId: "history" });
  assert.deepEqual(active.messages, result.messages);
  assert.equal(active.session.title, result.session.title);
  assert.equal(reads, 0);
  assert.throws(
    () => read({ sessionId: "missing" }),
    (e) => e.code === -32002,
  );
  assert.equal(reads, 1);
});
