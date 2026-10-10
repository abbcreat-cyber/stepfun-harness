import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const require = createRequire(new URL("../../desktop/package.json", import.meta.url)),
  { build } = require("esbuild"),
  { chromium } = require("playwright-core");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
test("搜索串行收口并跳过过期输入，错误后可继续，作用域互不阻塞", { timeout: 30000 }, async () => {
  let browser;
  try {
    const bundle = await build({
      stdin: {
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{useWorkspaceFileQuery}from'./packages/ui/src/hooks/useWorkspaceFileQuery.ts';
window.qa={pending:[],set:null};const service={searchWorkspaceFiles(params){return new Promise((resolve,reject)=>window.qa.pending.push({params,resolve,reject}))}};window.qa.service=service;
function App(){const[t,set]=useState({path:'D:/qa',query:'a'});window.qa.set=delta=>set(t=>({...t,...delta}));const r=useWorkspaceFileQuery(t.path,undefined,t.query,true,10);return React.createElement('output',{id:'state'},JSON.stringify({...r,error:r.error?.message??null}));}createRoot(document.getElementById('root')).render(React.createElement(App));`,
        resolveDir: repo,
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      nodePaths: [join(repo, "node_modules")],
      plugins: [
        {
          name: "service",
          setup(p) {
            p.onResolve({ filter: /^\.\/useServices\.js$/ }, () => ({
              path: "service",
              namespace: "test",
            }));
            p.onLoad({ filter: /.*/, namespace: "test" }, () => ({
              contents: "export const useServices=()=>({fileService:window.qa.service});",
            }));
          },
        },
      ],
    });
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const pending = (n) => page.waitForFunction((n) => window.qa.pending.length === n, n);
    const change = async (delta) => {
      await page.evaluate((d) => window.qa.set(d), delta);
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
    };
    const state = () => page.locator("#state").evaluate((e) => JSON.parse(e.textContent));
    const resolve = (i, name) =>
      page.evaluate(
        ({ i, name }) =>
          window.qa.pending[i].resolve([{ name, path: name, relativePath: name, type: "file" }]),
        { i, name },
      );
    await pending(1);
    await change({ query: "b" });
    await change({ query: "c" });
    assert.equal(await page.evaluate(() => window.qa.pending.length), 1);
    await resolve(0, "old");
    await pending(2);
    assert.equal(await page.evaluate(() => window.qa.pending[1].params.query), "c");
    await resolve(1, "latest");
    await page.waitForFunction(
      () => JSON.parse(document.querySelector("#state").textContent).entries[0]?.name === "latest",
    );
    await change({ query: "fail" });
    await pending(3);
    await page.evaluate(() => window.qa.pending[2].reject(Error("temporary")));
    await page.waitForFunction(
      () => JSON.parse(document.querySelector("#state").textContent).error === "temporary",
    );
    await change({ query: "retry" });
    await pending(4);
    await resolve(3, "recovered");
    await page.waitForFunction(
      () =>
        JSON.parse(document.querySelector("#state").textContent).entries[0]?.name === "recovered",
    );
    assert.equal((await state()).error, null);
    await change({ query: "waiting" });
    await pending(5);
    await change({ path: "D:/other", query: "other" });
    await pending(6);
    await resolve(5, "other");
    await page.waitForFunction(
      () => JSON.parse(document.querySelector("#state").textContent).entries[0]?.name === "other",
    );
    await resolve(4, "stale");
    assert.equal((await state()).entries[0].name, "other");
    await change({ query: "miss" });
    await pending(7);
    await page.evaluate(() => window.qa.pending[6].resolve([]));
    await pending(8);
    assert.equal(await page.evaluate(() => window.qa.pending[7].params.refresh), true);
    await resolve(7, "fresh");
    await page.waitForFunction(
      () => JSON.parse(document.querySelector("#state").textContent).entries[0]?.name === "fresh",
    );
  } finally {
    await browser?.close();
  }
});
