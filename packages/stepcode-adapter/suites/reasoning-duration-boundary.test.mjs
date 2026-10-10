import test from "node:test";
import assert from "node:assert/strict";
import { StepStreamProjection } from "../src/stream-projection.mjs";

for (const explicit of [true, false])
  test(`思考 ${explicit ? "显式结束" : "缺少end"} 后正文和工具参数不计入思考时长`, () => {
    const original = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const rows = [],
        p = new StepStreamProjection(rows, "turn", "model");
      p.handle({ type: "message_start", message: { role: "assistant" } });
      p.handle({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "thought" },
      });
      now = 3000;
      if (explicit)
        p.handle({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "thought" },
        });
      p.handle({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "我先确认文件的内容。",
        },
      });
      assert.equal(rows[0].durationMs, 2000);
      assert.equal(rows[0].state, "complete");
      now = 92000;
      p.handle({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "thought" },
            { type: "text", text: "我先确认文件的内容。" },
            { type: "toolCall", id: "tool", name: "read_file", arguments: { path: "file" } },
          ],
        },
      });
      assert.equal(rows[0].durationMs, 2000);
      assert.equal(rows[1].text, "我先确认文件的内容。");
    } finally {
      Date.now = original;
    }
  });
test("思考中取消仍结算，后续重复结束不增加时长", () => {
  const original = Date.now;
  let now = 100;
  Date.now = () => now;
  try {
    const rows = [],
      p = new StepStreamProjection(rows, "turn", "model");
    p.handle({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "partial" },
    });
    now = 600;
    p.handle({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "thinking", thinking: "partial" }],
      },
    });
    now = 1000;
    p.handle({ type: "agent_settled" });
    assert.equal(rows[0].durationMs, 500);
    assert.equal(rows[0].state, "interrupted");
  } finally {
    Date.now = original;
  }
});
