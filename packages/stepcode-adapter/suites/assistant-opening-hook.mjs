import { test } from "node:test";
import assert from "node:assert/strict";
import { registerAssistantOpeningHook, OPENING_REQUIRED, OPENING_STOPPED, withOpeningTimingPolicy } from "../src/assistant-opening-hook.mjs";

test("opening hook gates whole silent batch, allows real prose, stops second silent batch and resets", () => {
  const hooks = new Map(); registerAssistantOpeningHook({ on: (name, fn) => hooks.set(name, fn) });
  let leaf = "one"; const ctx = { sessionManager: { getLeafId: () => leaf } };
  const call = () => hooks.get("tool_call")({}, ctx);
  hooks.get("before_agent_start")({ prompt: "检查文件" });
  assert.ok(call().reason.includes(OPENING_REQUIRED));
  assert.equal(call().terminate, undefined, "siblings share same deferred batch");
  leaf = "two";
  assert.ok(call().reason.includes(OPENING_STOPPED)); assert.equal(call().terminate, true);
  hooks.get("before_agent_start")({ prompt: "检查另一个文件" });
  hooks.get("message_end")({ message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } });
  assert.ok(call().block, "thinking is not public opening");
  hooks.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "我先核对指定文件。" }] } });
  assert.equal(call(), undefined);
  hooks.get("before_agent_start")({ prompt: "只给结果" });
  assert.equal(call(), undefined);
});

test("开场时机约束随开关和只要结果豁免，不重复注入",()=>{
 const prompt=withOpeningTimingPolicy("BASE", "完成报告");
 assert.match(prompt,/不要先在思考中完成/);assert.match(prompt,/不为满足开场而增加无关工具/);
 assert.equal(withOpeningTimingPolicy(prompt,"完成报告"),prompt);
 assert.equal(withOpeningTimingPolicy(prompt,"完成报告",false),"BASE");
 for(const q of ["只给结果","不要过程说明","只输出JSON","only the answer"])assert.equal(withOpeningTimingPolicy("BASE",q),"BASE");
});

test("纯套话不满足开场准入，具体目标和下一步正常放行", () => {
  const hooks = new Map(); registerAssistantOpeningHook({ on: (name, fn) => hooks.set(name, fn) });
  const ctx = { sessionManager: { getLeafId: () => "a" } };
  hooks.get("before_agent_start")({ prompt: "制作一幅山水画" });
  hooks.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "好的，正在处理，请稍等。" }] } });
  assert.equal(hooks.get("tool_call")({}, ctx)?.block, true);
  hooks.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "我会画一幅水墨山水，先确定远山与水面的构图，再写入 SVG。" }] } });
  assert.equal(hooks.get("tool_call")({}, ctx), undefined);
});
