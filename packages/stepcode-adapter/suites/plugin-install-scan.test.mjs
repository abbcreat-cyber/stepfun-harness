import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStepPluginHandlers } from "../src/plugins.mjs";

test("安装复用安装后扫描，不向公开返回泄露内部快照，后续查询保持新鲜", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "install-scan-"));
  for (const name of ["observer", "target"]) {
    await fs.mkdir(join(root, "plugins", name), { recursive: true });
    await fs.writeFile(
      join(
        root,
        "plugins",
        name,
        name === "target" ? "step.plugin.disabled.json" : "step.plugin.json",
      ),
      JSON.stringify({ id: name, name, mcpServers: {} }),
    );
  }
  const manifest = join(root, "plugins/observer/step.plugin.json"),
    read = fs.readFile;
  let reads = 0;
  const mock = t.mock.method(fs, "readFile", async function (file, ...args) {
    if (String(file) === manifest) reads++;
    return read.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  try {
    const handlers = createStepPluginHandlers(root);
    const dry = await handlers["plugins/install"]({ pluginId: "target@stepcode", dryRun: true });
    assert.equal(dry.installedPlugins.find((p) => p.id === "target@stepcode").enabled, false);
    assert.equal(reads, 1);
    reads = 0;
    const installed = await handlers["plugins/install"]({ pluginId: "target@stepcode" });
    assert.equal(installed.installedPlugins.find((p) => p.id === "target@stepcode").enabled, true);
    assert.equal(reads, 2);
    assert.deepEqual(Object.keys(installed).sort(), [
      "dependencyClosure",
      "diagnostics",
      "installedPlugins",
    ]);
    const disabled = await handlers["plugins/setEnabled"]({
      pluginId: "target@stepcode",
      enabled: false,
    });
    assert.deepEqual(Object.keys(disabled).sort(), ["enabled", "plugin"]);
    assert.equal(disabled.enabled, false);
    await fs.writeFile(
      manifest,
      JSON.stringify({ id: "observer", name: "updated", mcpServers: {} }),
    );
    const current = await handlers["plugins/overview"]({ installedPlugins: [{ id: "fake" }] });
    assert.equal(
      current.installedPlugins.find((p) => p.id === "observer@stepcode").name,
      "updated",
    );
    assert.equal(current.installedPlugins.find((p) => p.id === "target@stepcode").enabled, false);
    await assert.rejects(handlers["plugins/install"]({ pluginId: "../invalid" }), /无效/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
