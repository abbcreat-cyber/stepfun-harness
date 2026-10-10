import test from "node:test";
import assert from "node:assert/strict";
import { visibleAssistantText, visibleConversationRows } from "../src/assistant-text.mjs";
import { StepStreamProjection } from "../src/stream-projection.mjs";
import { withDefaultLanguage } from "../src/default-language.mjs";

test("ordinary prose and HTML remain literal, split markers keep the existing code rules", () => {
  for (const text of ["普通正文".repeat(10000), "比较 x < y，再写 <div>HTML</div>", "`示例`和```代码```", "结束</tool_call>"])
    for (const streaming of [true,false]) assert.equal(visibleAssistantText(text,{streaming}),text);
  const marker="<tool_call>";
  for(let end=1;end<marker.length;end++){
    const partial=marker.slice(0,end);
    assert.equal(visibleAssistantText("正文"+partial,{streaming:true}),"正文");
    assert.equal(visibleAssistantText("正文"+partial),"正文"+partial);
    assert.equal(visibleAssistantText("`"+partial,{streaming:true}),"`"+partial);
    assert.equal(visibleAssistantText("```\n"+partial,{streaming:true}),"```\n"+partial);
  }
  assert.equal(visibleAssistantText("<tool_call>raw</tool_call>",{strip:false}),"<tool_call>raw</tool_call>");
});
test("tool protocol fragments never leak while ordinary prose and code examples remain", () => {
  const raw =
    "先检查文件。<tool_call><function=read_file><parameter=path>D:/test</tool_call>已读完。";
  assert.equal(visibleAssistantText(raw), "先检查文件。已读完。");
  assert.equal(visibleAssistantText("处理中<tool_ca", { streaming: true }), "处理中");
  const example = "格式示例：`<tool_call><function=test></tool_call>`";
  assert.equal(visibleAssistantText(example), example);
  const rows = [
    { rowId: 1, kind: "assistantText", assistantResponseId: "r", text: raw },
    { rowId: 2, kind: "toolCall", assistantResponseId: "r", toolName: "read_file" },
  ];
  assert.equal(visibleConversationRows(rows)[0].text, "先检查文件。已读完。");
});
test("live projection removes duplicated markup without dropping native tools", () => {
  const rows = [],
    p = new StepStreamProjection(rows, "t", "model");
  p.handle({ type: "message_start", message: { role: "assistant" } });
  for (const text of ["先检查。", "<tool_ca", "ll><function=read_file>x</tool_call>"]) {
    p.handle({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    });
    assert.ok(!rows.some((r) => r.kind === "assistantText" && r.text.includes("<tool")));
  }
  p.handle({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "先检查。<tool_call><function=read_file>x</tool_call>" },
        { type: "toolCall", id: "tool", name: "read_file", arguments: { path: "test" } },
      ],
    },
  });
  assert.equal(rows.find((r) => r.kind === "assistantText").text, "先检查。");
  assert.equal(rows.filter((r) => r.kind === "toolCall").length, 1);
});
test("silent tool work does not fabricate assistant prose or final counts, errors stay visible", () => {
  const rows = [],
    p = new StepStreamProjection(rows, "t", "model");
  p.handle({
    type: "tool_execution_start",
    toolCallId: "tool",
    toolName: "read_file",
    args: { path: "test" },
  });
  assert.ok(!rows.some((r) => r.kind === "assistantText"));
  p.handle({
    type: "tool_execution_end",
    toolCallId: "tool",
    toolName: "read_file",
    isError: true,
    result: { content: [{ type: "text", text: "file not found" }] },
  });
  p.handle({ type: "agent_settled" });
  assert.ok(!rows.some((r) => r.kind === "assistantText"));
  assert.equal(rows.find((r) => r.kind === "toolCall").output.text, "file not found");
});
test("Chinese preference is a native system append and allows explicit language requests", () => {
  const command = ["step.exe", "--mode", "rpc"];
  const decorated = withDefaultLanguage(command);
  assert.deepEqual(command, ["step.exe", "--mode", "rpc"]);
  assert.equal(decorated[3], "--append-system-prompt");
  assert.match(decorated[4], /默认使用简体中文/);
  assert.match(decorated[4], /用户明确要求其他语言/);
});
test("workflow display names follow the session language while explicit scripts stay unchanged", () => {
  const instruction = withDefaultLanguage(["step.exe", "--mode", "rpc"])[4];
  assert.match(instruction, /agent\(name\)/);
  assert.match(instruction, /phase\(name\)/);
  assert.match(instruction, /不是代码标识符/);
  assert.match(instruction, /用户明确指定的名称或要求原样执行的脚本/);
});
