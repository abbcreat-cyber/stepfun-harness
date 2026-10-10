import { test } from "node:test";
import assert from "node:assert/strict";
import { setupBrowserRuntime } from "../../../vendor/step-official-plugins/browser-use/scripts/browser-client.mjs";
import { refreshBundledBrowserClient } from "../src/bundled-browser-client.mjs";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { register } = await import("tsx/esm/api"); register();
const { BrowsersFacade } = await import("../../../apps/zcode-cli/packages/core/src/browser-client/facade.ts");
const { PlaywrightLocator } = await import("../../../apps/zcode-cli/packages/core/src/browser-client/playwright.ts");

function fixture(current = "https://example.test/form") {
  let navigations = 0, created = 0, draft = "已填写";
  const tab = { url: async () => current, goto: async url => { current = url; navigations++; draft = ""; } };
  const owner = { getDefault: async () => ({ tabs: { reuse: async () => tab, new: async () => { created++; return tab; } } }) };
  return { open: (...args) => BrowsersFacade.prototype.open.call(owner, ...args), tab, state: () => ({ navigations, created, draft }) };
}
test("opening the same tab URL preserves form state across fresh calls", async () => {
  const f = fixture(); await f.open("https://example.test/form"); await f.open("https://example.test/form");
  assert.deepEqual(f.state(), { navigations: 0, created: 0, draft: "已填写" });
});
test("equivalent URL syntax does not refresh but changed query and explicit goto still navigate", async () => {
  const f = fixture("https://example.test/"); await f.open("https://example.test:443");
  assert.equal(f.state().navigations, 0);
  await f.open("https://example.test/?page=2"); assert.equal(f.state().navigations, 1);
  await f.tab.goto("https://example.test/?page=2"); assert.equal(f.state().navigations, 2);
  await f.open("https://example.test/?page=2", { reuseTab: false }); assert.equal(f.state().created, 1);
});

test("shipped browser bundle preserves state when a fresh kernel reopens its owned tab", async () => {
  let navigations = 0;
  for (let i = 0; i < 2; i++) {
    const globals = {};
    globals[Symbol.for("zcode.node-repl.browser-control-bridge")] = {
      assertAvailable() {},
      list: async () => [{ id: "iab", type: "iab", generation: 1, capabilities: { browser: [], tab: [] } }],
      execute: async (_id, _generation, command) => {
        const tab = { tabId: "one", url: "https://example.test/form", active: true };
        if (command.method === "list") return { ok: true, tabs: [tab] };
        if (command.method === "activateTab") return { ok: true, tab };
        if (command.method === "getState") return { ok: true, state: { url: tab.url } };
        if (command.method === "navigate") { navigations++; return { ok: true }; }
        throw new Error(command.method);
      },
    };
    await setupBrowserRuntime({ globals });
    await globals.agent.browsers.open("https://example.test/form");
  }
  assert.equal(navigations, 0);
});

test("browser runtime migration never replaces a customized client", async t => {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "browser-client-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  const file = join(root, "scripts/browser-client.mjs");
  await writeFile(file, "// user customization\n");
  assert.equal(await refreshBundledBrowserClient(root, root, "browser-use", { stepOfficial: true }), false);
  assert.equal(await readFile(file, "utf8"), "// user customization\n");
});

test("inputValue uses the existing locator evaluate channel with selector and timeout preserved", async () => {
  const calls = [];
  const locator = new PlaywrightLocator(async command => { calls.push(command); return { ok: true, value: "林小星" }; }, {}, "#name");
  assert.equal(await locator.inputValue({ timeoutMs: 2000 }), "林小星");
  assert.equal(calls[0].action.operation, "evaluate");
  assert.equal(calls[0].action.selector, "#name");
  assert.equal(calls[0].action.timeoutMs, 2000);
});

test("shipped inputValue and innerText retain valid operation arguments together", async () => {
  const calls = [], globals = {};
  globals[Symbol.for("zcode.node-repl.browser-control-bridge")] = {
    assertAvailable() {},
    list: async () => [{ id: "iab", type: "iab", generation: 1, capabilities: { browser: [], tab: [] } }],
    execute: async (_id, _generation, command) => {
      const tab = { tabId: "one", url: "https://example.test/form", active: true };
      if (command.method === "list") return { ok: true, tabs: [tab] };
      if (command.method === "activateTab") return { ok: true, tab };
      if (command.method === "getState") return { ok: true, state: { url: tab.url } };
      if (command.method === "playwright") { calls.push(command.action); return { ok: true, value: "林小星" }; }
      throw new Error(command.method);
    },
  };
  await setupBrowserRuntime({ globals });
  const tab = await globals.agent.browsers.open("https://example.test/form");
  assert.equal(await tab.playwright.getByRole("textbox").inputValue(), "林小星");
  assert.equal(await tab.playwright.getByText(/已保存/).innerText({ timeoutMs: 1234 }), "林小星");
  assert.equal(calls[1].operation, "innerText");
  assert.equal(calls[1].timeoutMs, 1234);
  assert.ok(!Object.keys(calls[1]).some(key => /^\d+$/.test(key)));
});
