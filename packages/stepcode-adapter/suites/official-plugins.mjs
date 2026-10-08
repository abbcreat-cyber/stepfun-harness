import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createStepPluginHandlers } from "../src/plugins.mjs";
import { isUnavailableOfficialPlugin } from "../src/official-plugins.mjs";
import {
  OFFICIAL_PLUGIN_NAMES,
  officialPluginSource,
  pluginConfigSignature,
} from "../src/official-plugins.mjs";

const source = officialPluginSource();
let available = true;
try {
  await readFile(join(source, "catalog.json"));
} catch {
  available = false;
}
const temporary = () => mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "official-plugins-"));
test(
  "available original plugins retain complete skills/commands and working enable/configure facts",
  { skip: !available, timeout: 30000 },
  async () => {
    const { register } = await import("tsx/esm/api");
    register();
    const {
      zcodePluginsListResultSchema,
      zcodePluginsOverviewResultSchema,
      zcodePluginsSetEnabledResultSchema,
      zcodePluginsConfigureResultSchema,
    } = await import("../../shared/src/zcode-protocol/index.ts");
    const root = await temporary(),
      handlers = createStepPluginHandlers(root, { officialSource: source });
    const before = await handlers["plugins/list"]();
    zcodePluginsListResultSchema.parse(before);
    zcodePluginsOverviewResultSchema.parse(await handlers["plugins/overview"]());
    const official = before.plugins.filter((p) => p.marketplace === "zcode-plugins-official");
    assert.equal(
      official.length,
      OFFICIAL_PLUGIN_NAMES.filter((name) => !isUnavailableOfficialPlugin(name)).length,
    );
    assert.ok(!official.some((plugin) => isUnavailableOfficialPlugin(plugin.id.split("@")[0])));
    for (const name of OFFICIAL_PLUGIN_NAMES.filter(isUnavailableOfficialPlugin))
      await assert.rejects(readFile(join(root, "plugins", name, "step.plugin.json")), { code: "ENOENT" });
    assert.equal(before.diagnostics.length, 0);
    for (const name of OFFICIAL_PLUGIN_NAMES) {
      if (isUnavailableOfficialPlugin(name)) continue;
      const plugin = official.find((p) => p.id === `${name}@zcode-plugins-official`);
      assert.ok(plugin);
      await readFile(join(plugin.rootPath, ".zcode-plugin/plugin.json"));
      await readFile(join(plugin.rootPath, "step.plugin.json"));
    }
    const signature = await pluginConfigSignature(root);
    const disabled = await handlers["plugins/setEnabled"]({
      pluginId: "pdf@zcode-plugins-official",
      enabled: false,
    });
    zcodePluginsSetEnabledResultSchema.parse(disabled);
    assert.equal(disabled.enabled, false);
    assert.notEqual(await pluginConfigSignature(root), signature);
    const after = await handlers["plugins/list"]();
    assert.equal(after.plugins.find((p) => p.id === "pdf@zcode-plugins-official").enabled, false);
    zcodePluginsSetEnabledResultSchema.parse(
      await handlers["plugins/setEnabled"]({
        pluginId: "pdf@zcode-plugins-official",
        enabled: true,
      }),
    );
    zcodePluginsConfigureResultSchema.parse(
      await handlers["plugins/configure"]({
        pluginId: "android-emulator@zcode-plugins-official",
        options: { sdk_path: "D:/test-sdk" },
      }),
    );
    assert.equal(
      (await handlers["plugins/list"]()).plugins.find(
        (p) => p.id === "android-emulator@zcode-plugins-official",
      ).configuredOptions.sdk_path,
      "D:/test-sdk",
    );
    if (process.platform !== "darwin")
      await assert.rejects(
        handlers["plugins/setEnabled"]({
          pluginId: "ios-simulator@zcode-plugins-official",
          enabled: true,
        }),
        /找不到/,
      );
    await handlers["plugins/setEnabled"]({
      pluginId: "browser-use@zcode-plugins-official",
      enabled: false,
    });
    let switched = await handlers["plugins/list"]();
    assert.ok(!switched.plugins.some((p) => p.id === "computer-use@zcode-plugins-official"));
    switched = await handlers["plugins/list"]();
    assert.ok(!switched.plugins.some((p) => p.enabled && p.mcpServerNames.includes("node_repl")));
    await handlers["plugins/setEnabled"]({
      pluginId: "browser-use@zcode-plugins-official",
      enabled: true,
    });
    await assert.rejects(
      handlers["plugins/setEnabled"]({
        pluginId: "computer-use@zcode-plugins-official",
        enabled: true,
      }),
      /找不到/,
    );
    const catalog = await handlers["plugins/referenceCatalog"]();
    for (const name of [
      "docx",
      "pdf",
      "pptx",
      "xlsx",
      "control-browser",
      "skill-creator",
    ]) {
      assert.ok(
        catalog.plugins.some((p) => p.skillQualifiedNames.some((n) => n.endsWith(":" + name))),
        name,
      );
    }
  },
);

test(
  "original Node Repl host really executes js through MCP and keeps trusted browser metadata",
  { skip: !available, timeout: 30000 },
  async () => {
    const root = await temporary(),
      handlers = createStepPluginHandlers(root, { officialSource: source });
    await handlers["plugins/list"]();
    const calls = [];
    const relay = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const command = JSON.parse(raw);
      calls.push(command);
      let result;
      if (command.method === "context")
        result = {
          sessionId: "session-original-test",
          turnId: "turn-1",
          workspacePath: root,
          workspaceKey: root,
          clientMode: "desktop-continuous",
        };
      else if (command.method === "status") result = { ok: true };
      else if (command.method === "browserList")
        result = {
          browsers: [
            {
              id: "iab-test",
              type: "iab",
              name: "内置浏览器",
              generation: 1,
              capabilities: { browser: [], tab: [] },
            },
          ],
        };
      else result = { ok: false, reason: "official_auth_unavailable" };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    await mkdir(join(root, "browser-bridges"), { recursive: true });
    await writeFile(
      join(root, "browser-bridges", `${process.pid}.json`),
      JSON.stringify({
        endpoint: `http://127.0.0.1:${relay.address().port}/execute`,
        token: "fixture-private-token",
      }),
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../bin/official-plugin-mcp.mjs", import.meta.url)),
        "--plugin-root",
        join(root, "plugins/browser-use"),
        "--mcp-name",
        "node_repl",
      ],
      {
        env: { ...process.env, STEPCODE_STORAGE_ROOT_DIR: root },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stderr = "",
      seq = 0;
    const pending = new Map();
    child.stderr.on("data", (c) => (stderr += c));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let f;
      try {
        f = JSON.parse(line);
      } catch {
        return;
      }
      const item = pending.get(f.id);
      if (item) {
        pending.delete(f.id);
        clearTimeout(item.timer);
        if (f.error) item.reject(Error(f.error.message));
        else item.resolve(f.result);
      }
    });
    const request = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(Error("MCP response timed out: " + stderr.slice(-1500)));
          }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
      const listed = await request("tools/list");
      assert.ok(listed.tools.some((t) => t.name === "js"));
      const result = await request("tools/call", {
        name: "js",
        arguments: {
          title: "验证原版宿主",
          code: "nodeRepl.write({sum:20+22,session:nodeRepl.requestMeta.session_id})",
        },
      });
      assert.notEqual(result.isError, true);
      assert.ok(result.content.some((c) => c.type === "text" && c.text.includes("42")));
      assert.ok(
        result.content.some((c) => c.type === "text" && c.text.includes("session-original-test")),
      );
      const browser = await request("tools/call", {
        name: "js",
        arguments: {
          title: "只读浏览器清单",
          code: 'const bridge=globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")];nodeRepl.write(await bridge.list())',
        },
      });
      assert.notEqual(browser.isError, true, JSON.stringify(browser));
      assert.ok(
        calls.some(
          (c) => c.method === "browserList" && c.params.sessionId === "session-original-test",
        ),
      );
    } finally {
      child.stdin.end();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        setTimeout(() => {
          child.kill();
          resolve();
        }, 2000).unref();
      });
      relay.closeAllConnections();
      await new Promise((r) => relay.close(r));
    }
  },
);
