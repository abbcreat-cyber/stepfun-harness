import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// 用真实 React effect 和浏览器验证常驻菜单的开合，不以纯函数测试冒充请求生命周期。
// node --test packages/ui/test/stepCommunityBalanceLifecycle.test.mjs
const requireDesktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { build } = requireDesktop("esbuild");
const { chromium } = requireDesktop("playwright-core");
const repo = fileURLToPath(new URL("../../../", import.meta.url));

test("余额只在展开时请求，失败后重开重试，迟回结果不覆盖新请求", { timeout: 30000 }, async () => {
  let browser;
  try {
    const bundle = await build({
      stdin: {
        contents: `import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {useStepCommunityBalance} from "./packages/ui/src/hooks/useStepCommunityBalance.ts";
const pending=[];window.balanceTest={calls:0,pending,logs:[],setEnabled:null};
const services={stepCommunityService:{getAccountBalance(){window.balanceTest.calls++;return new Promise((resolve,reject)=>pending.push({resolve,reject}));}}};
function Test(){const [enabled,setEnabled]=useState(false);window.balanceTest.setEnabled=setEnabled;
const state=useStepCommunityBalance(services,enabled);return React.createElement("output",{id:"state"},JSON.stringify(state));}
createRoot(document.getElementById("root")).render(React.createElement(Test));`,
        resolveDir: repo, loader: "tsx",
      },
      bundle: true, write: false, format: "iife", platform: "browser",
      nodePaths: [join(repo, "node_modules")],
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [{ name: "test-logger", setup(plugin) {
        plugin.onResolve({ filter: /^@\/logger\.js$/ }, () => ({ path: "logger", namespace: "test" }));
        plugin.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const logger={warn(...args){window.balanceTest.logs.push(args);}};" }));
      } }],
    });
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForSelector("#state");
    const state = () => page.locator("#state").evaluate(e => JSON.parse(e.textContent));
    const enabled = value => page.evaluate(value => window.balanceTest.setEnabled(value), value);
    const calls = value => page.waitForFunction(value => window.balanceTest.calls === value, value);
    const resolve = (index, value) => page.evaluate(({ index, value }) => window.balanceTest.pending[index].resolve(value), { index, value });
    assert.equal(await page.evaluate(() => window.balanceTest.calls), 0);
    await enabled(true); await calls(1);
    await page.evaluate(() => window.balanceTest.pending[0].reject(new Error("offline")));
    await page.waitForFunction(() => !JSON.parse(document.getElementById("state").textContent).loading);
    assert.equal((await state()).balance, null);
    await enabled(false); await enabled(true); await calls(2);
    await resolve(1, { status: "ok", balance: 0 });
    await page.waitForFunction(() => JSON.parse(document.getElementById("state").textContent).balance?.balance === 0);
    await enabled(false);
    await page.waitForFunction(() => JSON.parse(document.getElementById("state").textContent).balance === null);
    await enabled(true); await calls(3);
    await enabled(false); await enabled(true); await calls(4);
    await resolve(3, { status: "ok", balance: 1234.56 });
    await page.waitForFunction(() => JSON.parse(document.getElementById("state").textContent).balance?.balance === 1234.56);
    await resolve(2, { status: "ok", balance: 99 });
    await page.waitForTimeout(50);
    assert.equal((await state()).balance.balance, 1234.56);
    await enabled(false); await enabled(true); await calls(5);
    await enabled(false);
    const logs = await page.evaluate(() => window.balanceTest.logs.length);
    await page.evaluate(() => window.balanceTest.pending[4].reject(new Error("late offline")));
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.balanceTest.logs.length), logs);
    assert.equal((await state()).balance, null);
  } finally {
    await browser?.close();
  }
});
