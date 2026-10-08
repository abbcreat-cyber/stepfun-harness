import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { startEmbeddedBrowserRelay } from "../src/embedded-browser-relay.mjs";

test("both browser relays send strict Host fields despite rich desktop automation context", async t => {
  const { register } = await import("tsx/esm/api"); register();
  const { zcodeBrowserListParamsSchema, zcodeBrowserExecuteParamsSchema } = await import("../../shared/src/zcode-protocol/index.ts");
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || "D:/Temp/stepfun-harness-tests", "browser-contract-"));
  const directory = join(root, "browser-bridges");
  await mkdir(join(root, "plugins/browser-use"), { recursive: true });
  await writeFile(join(root, "plugins/browser-use/step.plugin.json"), "{}");
  const calls = [];
  const relay = await startEmbeddedBrowserRelay({ directory,
    getContext: () => ({ sessionId: "test-session", turnId: "turn", workspaceKey: "workspace", workspacePath: root,
      clientMode: "desktop-continuous", sessionContext: "live", desktopTaskMode: true, activeTurn: true,
      mode: "build", modelSelection: { modelId: "model" }, toolDisallowlist: [], activeAutomationId: "automation" }),
    requestHost: async (method, params) => {
      const wire = { ...params, requestId: "wire-id" };
      if (method === "interaction/browserList") zcodeBrowserListParamsSchema.parse(wire);
      else zcodeBrowserExecuteParamsSchema.parse(wire);
      calls.push(method);
      return method === "interaction/browserList" ? { browsers: [{ id: "iab", generation: 1, type: "iab" }] } : { ok: true };
    },
  });
  t.after(async () => { await relay.close(); await rm(root, { recursive: true, force: true }); });
  await relay.bindPid(42);
  const info = JSON.parse(await readFile(join(directory, "42.json"), "utf8"));
  for (const [endpoint, body] of [
    [info.endpoint, { method: "list" }],
    [info.endpoint.replace("/execute", "/official-plugin"), { method: "browserList", params: { sessionId: "test-session", turnId: "turn" } }],
    [info.endpoint.replace("/execute", "/official-plugin"), { method: "browserExecute", params: { sessionId: "test-session", turnId: "turn", browserId: "iab", browserGeneration: 1, command: { method: "list" } } }],
  ]) {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${info.token}` }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  }
  assert.equal(calls.length, 4);
});
