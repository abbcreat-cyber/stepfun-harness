import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStepPluginHandlers } from "../src/plugins.mjs";

test("插件校验每次只扫描一次，下一请求仍读取最新声明", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "validate-scan-"));
  const manifest = join(root, "plugins/check/step.plugin.json");
  await fs.mkdir(join(root, "plugins/check"), { recursive: true });
  await fs.writeFile(manifest, JSON.stringify({ id: "check", name: "check", mcpServers: {} }));
  const read = fs.readFile;
  let reads = 0;
  const mock = t.mock.method(fs, "readFile", async function (file, ...args) {
    if (String(file) === manifest) reads++;
    return read.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  try {
    const handlers = createStepPluginHandlers(root);
    assert.equal((await handlers["plugins/validate"]()).diagnostics.length, 0);
    assert.equal(reads, 1);
    await fs.writeFile(manifest, "invalid");
    reads = 0;
    const next = await handlers["plugins/validate"]();
    assert.equal(next.diagnostics.length, 1);
    assert.equal(reads, 1);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
