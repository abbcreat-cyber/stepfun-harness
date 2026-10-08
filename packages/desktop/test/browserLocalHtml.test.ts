import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  isAllowedBrowserUrl,
  isAllowedLocalHtmlTransition,
  isLocalHtmlBrowserUrl,
} from "../src/main/browserView/browserNavigationPolicy.ts";
import {
  handleEvaluate,
  handleNavigate,
} from "../src/main/browserView/browserCommandPageHandlers.ts";
import { EVALUATE_SCRIPT } from "../src/main/browserView/browserCommandScripts.ts";
import { createBrowserControlMainBridge } from "../src/host/browserControlMainBridge.ts";
import type { ControlledView } from "../src/main/browserView/browserCommandTypes.ts";

const pageUrl = "file:///D:/pages/%E4%B8%AD%E6%96%87%20page.html?theme=dark#intro";

test("local HTML supports encoded paths, queries and fragments while preserving web navigation", () => {
  for (const url of [
    pageUrl,
    "file:///D:/pages/中文.HTM",
    "file://localhost/D:/pages/test.html",
    "http://127.0.0.1:8791/",
    "https://example.com",
    "about:blank",
  ]) {
    assert.equal(isAllowedBrowserUrl(url), true, url);
  }
  assert.equal(isLocalHtmlBrowserUrl(pageUrl), true);
});

test("local preview rejects non-HTML, shared paths and invalid schemes", () => {
  for (const url of [
    "file:///D:/secret.json",
    "file://server/share/page.html",
    "file:////server/share/page.html",
    "file:///D:/page%00.html",
    "file:///D:/a%2Fb.html",
    "file:///D:/a%5Cb.html",
    "file:///D:/page.html:stream.html",
    "javascript:alert(1)",
    "data:text/html,<h1>test</h1>",
    "about:config",
    "not a URL",
  ]) {
    assert.equal(isAllowedBrowserUrl(url), false, url);
  }
});

test("page links permit local HTML navigation only from an existing local HTML document", () => {
  assert.equal(isAllowedLocalHtmlTransition("file:///D:/pages/next.htm", pageUrl), true);
  assert.equal(isAllowedLocalHtmlTransition(pageUrl, "https://example.com"), false);
  assert.equal(isAllowedLocalHtmlTransition(pageUrl, "about:blank"), false);
  assert.equal(isAllowedLocalHtmlTransition("file:///D:/private.json", pageUrl), false);
  assert.equal(isAllowedLocalHtmlTransition("https://example.com", pageUrl), true);
});

test("navigate actually loads local HTML and reports missing files as failures", async () => {
  const calls: string[] = [];
  const view: ControlledView = {
    webContents: {
      async loadURL(url) {
        calls.push(url);
        if (url.includes("missing")) throw new Error("ERR_FILE_NOT_FOUND");
      },
      getURL: () => pageUrl,
      getTitle: () => "中文预览",
      canGoBack: () => false,
      canGoForward: () => false,
      goBack() {},
      goForward() {},
      reload() {},
      async executeJavaScript() {},
    },
    cdp: { async send() {} },
  };
  const done = (result: Parameters<Parameters<typeof handleNavigate>[2]>[0]) => ({
    ...result,
    elapsedMs: 0,
  });
  assert.equal((await handleNavigate(view, { method: "navigate", url: pageUrl }, done)).ok, true);
  const failed = await handleNavigate(
    view,
    { method: "navigate", url: "file:///D:/missing.html" },
    done,
  );
  assert.equal(failed.ok, false);
  assert.match(failed.error?.message ?? "", /ERR_FILE_NOT_FOUND/);
  const blocked = await handleNavigate(
    view,
    { method: "navigate", url: "file:///D:/private.json" },
    done,
  );
  assert.equal(blocked.error?.code, "navigation_blocked");
  assert.deepEqual(calls, [pageUrl, "file:///D:/missing.html"]);
});

function evaluateView(): ControlledView {
  return {
    webContents: {
      async loadURL() {},
      getURL: () => "https://example.invalid/fixture",
      getTitle: () => "Evaluate fixture",
      canGoBack: () => false,
      canGoForward: () => false,
      goBack() {},
      goForward() {},
      reload() {},
      executeJavaScript: async (script) => await runInNewContext(script),
    },
    cdp: { async send() {} },
  };
}

test("evaluate awaits Promise values and reports rejections without changing expression semantics", async () => {
  const view = evaluateView();
  const done = (result: Parameters<Parameters<typeof handleEvaluate>[2]>[0]) => ({
    ...result,
    elapsedMs: 0,
  });
  for (const [expression, expected] of [
    ["42", 42],
    ["({ headline: 'fixture', count: 2 })", { headline: "fixture", count: 2 }],
    ["(async () => 42)()", 42],
    ["Promise.resolve({ headline: 'async fixture' })", { headline: "async fixture" }],
    ["Promise.resolve('async body')", "async body"],
    ["Promise.resolve(undefined)", "undefined"],
    ["Promise.resolve(42n)", "42"],
    ["() => 42", "() => 42"],
  ] as const) {
    const result = await handleEvaluate(view, { method: "evaluate", expression }, done);
    assert.equal(result.ok, true, expression);
    assert.deepEqual(result.value, expected, expression);
  }
  for (const expression of [
    "Promise.reject(new Error('async rejected'))",
    "(() => { throw new Error('sync rejected'); })()",
  ]) {
    const result = await handleEvaluate(view, { method: "evaluate", expression }, done);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "execution_error");
    assert.match(result.error?.message ?? "", /(?:async|sync) rejected/);
  }
});

test("a never-settling evaluate remains pending in the page and the existing Host deadline cancels its request", async () => {
  const pageResult = runInNewContext(EVALUATE_SCRIPT("new Promise(() => {})"));
  assert.equal(typeof pageResult?.then, "function");
  const messages: Parameters<
    Parameters<typeof createBrowserControlMainBridge>[0]["postToMain"]
  >[0][] = [];
  const bridge = createBrowserControlMainBridge({
    timeoutMs: 15,
    postToMain(message) {
      messages.push(message);
      if (message.command.method === "evaluate") {
        void pageResult.then(() =>
          bridge.handleResult({
            requestId: message.requestId,
            result: { ok: true, value: "unexpected", elapsedMs: 0 },
          }),
        );
      }
    },
  });
  try {
    const result = await bridge.execute({
      requestId: "never-evaluate",
      sessionId: "fixture-session",
      command: { method: "evaluate", expression: "new Promise(() => {})" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "timeout");
    assert.deepEqual(messages[1].command, { method: "cancelRequest", requestId: "never-evaluate" });
    assert.equal(messages[1].browserGeneration, messages[0].browserGeneration);
    assert.equal(messages[1].sessionId, messages[0].sessionId);

    const [descriptor] = await bridge.list();
    const stale = await bridge.execute({
      browserId: descriptor.id,
      browserGeneration: descriptor.generation - 1,
      sessionId: "fixture-session",
      command: { method: "evaluate", expression: "42" },
    });
    assert.equal(stale.error?.code, "backend_unavailable");
    assert.equal(messages.length, 2);

    const fresh = bridge.execute({
      requestId: "fresh-evaluate",
      sessionId: "fixture-session",
      command: { method: "evaluate", expression: "42" },
    });
    await bridge.handleResult({
      requestId: "never-evaluate",
      result: { ok: true, value: "late", elapsedMs: 0 },
    });
    await bridge.handleResult({
      requestId: "fresh-evaluate",
      result: { ok: true, value: 42, elapsedMs: 0 },
    });
    assert.equal((await fresh).value, 42);
  } finally {
    bridge.dispose();
  }
});
