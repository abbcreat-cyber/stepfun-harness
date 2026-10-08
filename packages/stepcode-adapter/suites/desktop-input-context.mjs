import { test } from "node:test";
import assert from "node:assert/strict";
import firstPrinciplesHook from "../src/first-principles-hook.mjs";

test("extension registers no extra reminder/message/system injection", () => {
  const handlers = new Map();
  firstPrinciplesHook({ on: (name, fn) => handlers.set(name, fn) });
  assert.equal(handlers.has("before_agent_start"), false);
  assert.deepEqual([...handlers.keys()], ["context"]);
});

test("old injected rule messages are filtered only from outgoing context, preserving actual users and other extensions", () => {
  const handlers = new Map();
  firstPrinciplesHook({ on: (name, fn) => handlers.set(name, fn) });
  const user = { role: "user", content: "第一性原理钩子是啥" };
  const other = { role: "custom", customType: "workflow", content: "WORKFLOW_RESULT" };
  const messages = [
    user,
    { role: "custom", customType: "first-principles", content: "LEGACY_RULE_READ_SOURCE" },
    other,
  ];
  const before = structuredClone(messages);
  assert.equal(typeof handlers.get("context"), "function");
  assert.deepEqual(handlers.get("context")({ messages }).messages, [user, other]);
  assert.deepEqual(messages, before, "stored session/history must not be mutated");
});
