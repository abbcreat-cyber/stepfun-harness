import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("old session plugin catalogs project live availability without mutating history", async () => {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "session-catalog-"));
  const plugin = join(root, "plugins", "pdf");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "step.plugin.json"), JSON.stringify({
    id: "pdf", name: "PDF", version: "1.0.0", stepOfficial: true, skills: [],
  }));
  const moduleUrl = new URL("../src/bridge/methods-session.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { mkdir, rename, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { createSessionMethods } from ${JSON.stringify(moduleUrl)};
    const hidden = ["computer-use", "image-search", "restore-legacy-sessions", "ios-simulator"];
    const history = hidden.map(name => ({ pluginId: name + "@zcode-plugins-official", enabled: true }));
    const primarySession = { sessionId: "legacy", pluginCatalog: history };
    const methods = createSessionMethods({ primarySession, turnBusy: true,
      readConversation: id => id === "saved" ? { session: { ...primarySession, sessionId: id } } : null });
    for (const method of ["plugins/referenceCatalog", "plugins/referenceCatalogWithCategory"]) {
      for (const sessionId of ["legacy", "saved"]) {
        const catalog = await methods[method]({ sessionId });
        assert.equal(catalog.authority, "session");
        assert.equal(catalog.plugins.some(p => hidden.some(n => p.pluginId.startsWith(n + "@"))), false);
        assert.equal(catalog.plugins.find(p => p.pluginId === "pdf@zcode-plugins-official").enabled, true);
      }
      await assert.rejects(methods[method]({ sessionId: "absent" }), /找不到/);
    }
    const root = process.env.STEPCODE_STORAGE_ROOT_DIR;
    await mkdir(join(root, "disabled-plugins"), { recursive: true });
    await rename(join(root, "plugins", "pdf"), join(root, "disabled-plugins", "pdf"));
    const updated = await methods["plugins/referenceCatalog"]({ sessionId: "legacy" });
    assert.equal(updated.plugins.find(p => p.pluginId === "pdf@zcode-plugins-official").enabled, false);
    assert.equal(primarySession.pluginCatalog, history);
    assert.equal(history.length, 4);
    console.log("session catalog live projection OK");
  `;
  const env = { ...process.env, STEPCODE_STORAGE_ROOT_DIR: root };
  delete env.STEP_BACKEND;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env, windowsHide: true, timeout: 15000,
  });
  assert.match(result.stdout, /session catalog live projection OK/);
});
