import { test } from "node:test";
import assert from "node:assert/strict";
import { registerAssistantOpeningHook, OPENING_REQUIRED, OPENING_STOPPED } from "../src/assistant-opening-hook.mjs";

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
