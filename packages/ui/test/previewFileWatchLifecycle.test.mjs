import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const requireDesktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { build } = requireDesktop("esbuild");
const { chromium } = requireDesktop("playwright-core");
const repo = fileURLToPath(new URL("../../../", import.meta.url));

test(
  "预览监听隔离路径和 service，释放迟到注册并允许失败后首次读取",
  { timeout: 30000 },
  async () => {
    let browser;
    try {
      const bundle = await build({
        stdin: {
          contents: `import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {usePreviewFileWatch} from "./packages/ui/src/hooks/usePreviewFileWatch.ts";
const q=window.qa={pending:[],released:[],disposed:[],listeners:{},set:null};
const services=[0,1].map(n=>({watch(){return new Promise((resolve,reject)=>q.pending.push({resolve,reject,n}));},unwatch({id}){q.released.push(id);return Promise.resolve();},onDynamicChange(id){return f=>{q.listeners[id]=f;return {dispose(){q.disposed.push(id);}};}}}));
function App(){const [target,set]=useState({path:'D:/qa/report.md',service:0});q.set=set;const s=usePreviewFileWatch({filePath:target.path,fileWatcherService:services[target.service]});return React.createElement('output',{id:'state'},JSON.stringify(s));}
createRoot(document.getElementById('root')).render(React.createElement(App));`,
          resolveDir: repo,
          loader: "tsx",
        },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        nodePaths: [join(repo, "node_modules")],
        define: { "process.env.NODE_ENV": '"development"' },
        plugins: [
          {
            name: "test-aliases",
            setup(plugin) {
              plugin.onResolve({ filter: /^@\/logger\.js$/ }, () => ({
                path: "logger",
                namespace: "test",
              }));
              plugin.onLoad({ filter: /.*/, namespace: "test" }, () => ({
                contents: "export const logger={warn(){},debug(){}};",
              }));
              plugin.onResolve({ filter: /^@\/lib\/path\.js$/ }, () => ({
                path: join(repo, "packages/ui/src/lib/path.ts"),
              }));
            },
          },
        ],
      });
      browser = await chromium.launch({ channel: "chrome", headless: true });
      const page = await browser.newPage();
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const state = () => page.locator("#state").evaluate((e) => JSON.parse(e.textContent));
      const pending = (n) => page.waitForFunction((n) => window.qa.pending.length === n, n);
      const resolve = (n, id) =>
        page.evaluate(({ n, id }) => window.qa.pending[n].resolve({ id }), { n, id });
      const emit = (id, changedPath) =>
        page.evaluate(({ id, changedPath }) => window.qa.listeners[id]({ changedPath }), {
          id,
          changedPath,
        });
      const generation = (n) =>
        page.waitForFunction(
          (n) => JSON.parse(document.getElementById("state").textContent).reloadGeneration === n,
          n,
        );
      await pending(1);
      assert.equal((await state()).ready, false);
      await resolve(0, "first");
      await page.waitForFunction(() => window.qa.listeners.first);
      await emit("first", "D:/qa/other.md");
      assert.equal((await state()).reloadGeneration, 0);
      await page.evaluate(() =>
        window.qa.listeners.first({ changedPaths: ["D:/qa/other.md", "D:/qa/another.md"] }),
      );
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      assert.equal(
        (await state()).reloadGeneration,
        0,
        "unrelated multi-file batch must not reload",
      );
      await emit("first", "d:\\QA\\REPORT.md");
      await generation(1);
      await emit("first", undefined);
      await generation(2);
      await page.evaluate(() =>
        window.qa.listeners.first({ changedPaths: ["D:/qa/other.md", "d:\\QA\\REPORT.md"] }),
      );
      await generation(3);
      await page.evaluate(() => window.qa.listeners.first({ changedPaths: [] }));
      await generation(4);
      await page.evaluate(() => window.qa.set({ path: "D:/qa/report.md", service: 1 }));
      await pending(2);
      assert.equal((await state()).ready, false);
      assert.deepEqual(await page.evaluate(() => window.qa.released), ["first"]);
      await emit("first", "D:/qa/report.md");
      assert.equal((await state()).reloadGeneration, 0);
      await page.evaluate(() => window.qa.set({ path: "D:/qa/new.md", service: 1 }));
      await pending(3);
      await resolve(1, "late");
      await page.waitForFunction(() => window.qa.released.includes("late"));
      assert.equal((await state()).ready, false);
      await page.evaluate(() => window.qa.pending[2].reject(new Error("watch unavailable")));
      await page.waitForFunction(
        () => JSON.parse(document.getElementById("state").textContent).ready,
      );
      await page.evaluate(() => window.qa.set({ path: "D:/qa/final.md", service: 1 }));
      await pending(4);
      await resolve(3, "final");
      await page.waitForFunction(() => window.qa.listeners.final);
      await page.evaluate(() => window.qa.set({ path: null, service: 1 }));
      await page.waitForFunction(() => window.qa.released.includes("final"));
      assert.deepEqual(await page.evaluate(() => window.qa.disposed), ["first", "final"]);
    } finally {
      await browser?.close();
    }
  },
);
