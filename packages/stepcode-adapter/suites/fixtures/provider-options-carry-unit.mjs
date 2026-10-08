import assert from "node:assert/strict";
import { createProviderRequestOptions } from "../../src/extensions/provider-request-options.mjs";

// 与父 suite 的原断言相同；公开 TS CEL 依赖仅在独立 loader 进程中装载。
const hooks = new Map(),
  model = { provider: "carry", id: "model", maxTokens: 512 },
  key = () => "carry-model";
const binding = {
  optionSpecs: { reasoningLevel: { values: ["low"], map: '{"fixture_map":reasoningLevel}' } },
};
let idle = true;
const ctx = {
  model,
  isIdle: () => idle,
  ui: {
    setStatus(_key, text) {
      const receipt = JSON.parse(text);
      if (receipt.error) throw new Error(receipt.error);
    },
  },
};
const transport = createProviderRequestOptions(
  {
    on(event, fn) {
      hooks.set(event, fn);
    },
  },
  {
    bindings: new Map([[key(), binding]]),
    key,
    current: () => binding,
    generation: "fixture-generation",
  },
);
transport.initialize();
const command = (action, requestId) =>
  transport.handler(JSON.stringify({ action, requestId, options: { reasoningLevel: "low" } }), ctx);
const event = (name) => hooks.get(name)?.({ message: { role: "user" }, source: "rpc" }, ctx);
const mapped = () => transport.apply(model, {});
command("prepare", "initial");
event("before_agent_start");
idle = false;
command("carry", "ack-before-start");
event("input");
event("message_start");
event("agent_settled");
idle = true;
event("before_agent_start");
assert.equal(mapped().fixture_map, "low");
event("message_start");
event("agent_settled");
event("before_agent_start");
assert.throws(mapped, /not prepared/);
command("prepare", "normal");
event("before_agent_start");
event("message_start");
idle = false;
command("carry", "first");
event("input");
command("carry", "second");
event("message_start");
event("input");
event("message_start");
event("agent_settled");
idle = true;
event("before_agent_start");
assert.throws(mapped, /not prepared/);
command("prepare", "abort");
event("before_agent_start");
event("message_start");
idle = false;
const controller = new AbortController();
transport.watchAbort(controller.signal);
command("carry", "cancelled");
controller.abort();
event("agent_settled");
idle = true;
event("before_agent_start");
assert.throws(mapped, /not prepared/);
process.stdout.write("provider-options-carry-unit: passed\n");
