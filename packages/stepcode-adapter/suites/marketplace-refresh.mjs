import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchBridge, waitForExit } from "./helpers.mjs";

test("marketplace refresh routes through real bridge, validates schema and preserves plugin configuration", async t => {
  const { register } = await import("tsx/esm/api"); register();
  const { zcodePluginsMarketplaceMutationResultSchema } = await import("../../shared/src/zcode-protocol/index.ts");
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || "D:/Temp/stepfun-harness-tests", "marketplace-refresh-"));
  const plugin = join(root, "plugins/example"); await mkdir(plugin, { recursive: true });
  const file = join(plugin, "step.plugin.disabled.json"), manifest = JSON.stringify({ id: "example", name: "Example", version: "1.0.0", mcpServers: {} });
  await writeFile(file, manifest); await writeFile(join(plugin, "step-user-config.json"), '{"choice":"preserved"}');
  const bridge = launchBridge([], { STEPCODE_STORAGE_ROOT_DIR: root, STEP_BACKEND: undefined }, { stateDir: join(root, "bridge"), cwd: root });
  t.after(async () => { bridge.child.stdin.end(); await waitForExit(bridge.child); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  for (const [id, marketplace] of [[1, undefined], [2, "stepcode"]]) {
    bridge.send({ id, method: "plugins/marketplace/update", params: { workspace: { workspacePath: root, workspaceKey: root }, ...(marketplace ? { marketplace } : {}) } });
    const response = await bridge.waitFor(frame => frame.id === id);
    assert.equal(response.error, undefined, JSON.stringify(response));
    const result = zcodePluginsMarketplaceMutationResultSchema.parse(response.result);
    assert.ok(result.marketplaces.some(market => market.id === "stepcode"));
  }
  assert.equal(await readFile(file, "utf8"), manifest);
  assert.equal(await readFile(join(plugin, "step-user-config.json"), "utf8"), '{"choice":"preserved"}');
  bridge.send({ id: 3, method: "plugins/marketplace/update", params: { workspace: { workspacePath: root }, marketplace: "absent" } });
  const failure = await bridge.waitFor(frame => frame.id === 3);
  assert.match(failure.error?.message, /找不到/);
});
