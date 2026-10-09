import { test } from "node:test";
import assert from "node:assert/strict";
import { registerProviderToolIntegrity } from "../src/provider-tool-integrity.mjs";

function inspect({ initial = {}, raw, api = "anthropic-messages", stopReason = "toolUse" }) {
  const handlers = new Map(),
    model = { api },
    tool = { type: "toolCall", id: "size-test", name: "fixture", arguments: initial };
  registerProviderToolIntegrity(
    {
      on(name, handler) {
        handlers.set(name, handler);
      },
    },
    () => true,
    { maxRepairs: 0 },
  );
  const ctx = { model },
    message = { role: "assistant", stopReason, content: [tool] };
  handlers.get("message_start")({ message }, ctx);
  handlers.get("message_update")(
    {
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        partial: { content: [tool] },
      },
    },
    ctx,
  );
  if (raw !== undefined)
    handlers.get("message_update")(
      { assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: raw } },
      ctx,
    );
  return handlers.get("message_end")({ message }, ctx).message;
}

test("small structured Anthropic input and complete delta retain valid tool calls", () => {
  const initial = inspect({ initial: { path: "fixture" } });
  assert.equal(initial.stopReason, "toolUse");
  assert.deepEqual(initial.content[0].arguments, { path: "fixture" });
  const raw = inspect({ raw: '{"path":"fixture"}', api: "openai-completions" });
  assert.equal(raw.stopReason, "toolUse");
  assert.deepEqual(raw.content[0].arguments, { path: "fixture" });
});

test("structured initial and raw delta obey the same exact JSON length boundary", () => {
  const exact = { x: "a".repeat(1048576 - 8) },
    excessive = { x: "a".repeat(1048576 - 7) };
  assert.equal(JSON.stringify(exact).length, 1048576);
  assert.equal(inspect({ initial: exact }).stopReason, "toolUse");
  for (const result of [
    inspect({ initial: excessive }),
    inspect({ raw: JSON.stringify(excessive) }),
    inspect({ initial: ["invalid-object"] }),
    inspect({ raw: '{"x":1' }),
  ]) {
    assert.equal(result.stopReason, "error");
    assert.equal(result.content.length, 0);
    assert.match(result.errorMessage, /工具未执行/);
  }
});

test("cancelled or failed partial tool streams keep their native terminal reason", () => {
  for (const stopReason of ["error", "aborted"]) {
    const message = inspect({ raw: '{"x":1', stopReason });
    assert.equal(message.stopReason, stopReason);
    assert.equal(message.content.length, 0);
  }
});
