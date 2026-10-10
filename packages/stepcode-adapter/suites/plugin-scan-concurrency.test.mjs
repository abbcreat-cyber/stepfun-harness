import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStepPluginHandlers } from "../src/plugins.mjs";
test("插件目录受限并发，输出和错误顺序稳定，下一次读取保持新鲜", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "plugin-batch-"));
  for (const name of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    await fs.mkdir(join(root, "plugins", name), { recursive: true });
    await fs.writeFile(
      join(root, "plugins", name, "step.plugin.json"),
      ["c", "g"].includes(name) ? "invalid" : JSON.stringify({ id: name, name, mcpServers: {} }),
    );
  }
  const original = fs.readFile;
  let active = 0,
    peak = 0;
  const mocked = t.mock.method(fs, "readFile", async function (file, ...args) {
    if (!String(file).startsWith(root) || !String(file).endsWith("step.plugin.json"))
      return original.call(this, file, ...args);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((r) =>
        setTimeout(r, String(file).includes(join("plugins", "a")) ? 30 : 10),
      );
      return await original.call(this, file, ...args);
    } finally {
      active--;
    }
  });
  syncBuiltinESMExports();
  try {
    const handlers = createStepPluginHandlers(root),
      result = await handlers["plugins/list"]();
    assert.ok(peak > 1, "independent declarations should overlap");
    assert.ok(peak <= 4);
    assert.deepEqual(
      result.plugins.filter((p) => !p.packageStatus).map((p) => p.name),
      ["a", "b", "d", "e", "f", "h"],
    );
    assert.deepEqual(
      result.diagnostics.map((d) => d.message.split(":")[0]),
      ["c", "g"],
    );
    await fs.writeFile(
      join(root, "plugins/a/step.plugin.json"),
      JSON.stringify({ id: "a", name: "updated", mcpServers: {} }),
    );
    assert.equal((await handlers["plugins/list"]()).plugins[0].name, "updated");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
