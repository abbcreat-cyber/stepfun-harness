import { test } from "node:test";
import assert from "node:assert/strict";
import desktopTaskContracts from "../src/extensions/desktop-task-contracts.mjs";

test("desktop native command admission defaults foreground deadline and preserves explicit/background calls", async () => {
  const previous = process.env.STEPCODE_TASK_MODE;
  process.env.STEPCODE_TASK_MODE = "desktop";
  try {
    const handlers = new Map();
    desktopTaskContracts({ on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]) });
    const admission = async event => { for (const handler of handlers.get("tool_call")) await handler(event, { sessionManager: { getBranch: () => [] } }); };
    const input = { command: "sleep 100" };
    await admission({ toolName: "run_command", input });
    assert.equal(input.timeout_ms, 60000);
    for (const input of [
      { command: "build", timeout_ms: 1000 },
      { command: "build", timeout_ms: 600000 },
      { command: "server", run_in_background: true },
    ]) {
      const before = structuredClone(input);
      await admission({ toolName: "run_command", input });
      assert.deepEqual(input, before);
    }
    const other = { command: "not a shell" };
    await admission({ toolName: "other_tool", input: other });
    assert.equal(other.timeout_ms, undefined);
  } finally {
    if (previous === undefined) delete process.env.STEPCODE_TASK_MODE;
    else process.env.STEPCODE_TASK_MODE = previous;
  }
});

test("independent CLI does not install desktop command admission", () => {
  const previous = process.env.STEPCODE_TASK_MODE;
  delete process.env.STEPCODE_TASK_MODE;
  try {
    desktopTaskContracts({ on: () => assert.fail("desktop-only handler installed") });
  } finally {
    if (previous !== undefined) process.env.STEPCODE_TASK_MODE = previous;
  }
});
