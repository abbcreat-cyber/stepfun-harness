import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const requireDesktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { build } = requireDesktop("esbuild");
const { chromium } = requireDesktop("playwright-core");
const repo = fileURLToPath(new URL("../../../", import.meta.url));

test("草稿新激活先检查再预热，旧读取和旧 service 不提供就绪证明", { timeout: 30000 }, async () => {
  let browser;
  try {
    const bundle = await build({
      stdin: {
        contents: `import React,{useState,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {useDraftModelReadinessGate} from './packages/ui/src/v4/composer/useDraftModelReadinessGate.ts';
import {useDraftSessionPrewarm} from './packages/ui/src/v4/composer/useDraftSessionPrewarm.ts';
const q=window.qa={pending:[],listeners:[new Set(),new Set()],commands:[],renders:[],set:null,gate:null};
const services=[0,1].map(n=>({getView(){return new Promise((resolve,reject)=>q.pending.push({resolve,reject,n}));},onDidChange(f){q.listeners[n].add(f);return{dispose(){q.listeners[n].delete(f);}};}}));
const dispatch=async(type,payload,id)=>{q.commands.push(type);return {commandId:'c',status:'accepted',revisionAtDecision:0,...(type==='createSession'?{result:{type,sessionId:'draft-'+q.commands.length}}:{})};};
const transport={};
function App(){const [t,set]=useState({workspacePath:'D:/qa',provider:'zcode',sessionId:'existing',service:0,round:0});q.set=change=>set(t=>({...t,...change}));
const gate=useDraftModelReadinessGate({...t,modelSelectionService:services[t.service]});q.gate=gate;
useLayoutEffect(()=>{q.renders.push({round:t.round,allowed:gate.agentStartupAllowed});});
useDraftSessionPrewarm({enabled:t.sessionId===null&&gate.agentStartupAllowed,workspaceKey:t.workspacePath,paneId:'pane',transportIdentity:transport,dispatchCommand:dispatch});
return React.createElement('output',{id:'state'},JSON.stringify({allowed:gate.agentStartupAllowed,error:gate.error?.code??null,round:t.round}));}
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
            plugin.onResolve(
              { filter: /^(@zcode\/shared|@\/logger\.js|@\/lib\/chatPrepareError\.js)$/ },
              (args) => ({ path: args.path, namespace: "test" }),
            );
            plugin.onLoad({ filter: /.*/, namespace: "test" }, (args) => ({
              contents:
                args.path === "@zcode/shared"
                  ? "export const ZCODE_AGENT_PROVIDER='zcode';export const isZCodeAgentProvider=p=>p==='zcode'||p==='zcode-alt';"
                  : args.path.includes("logger")
                    ? "export const logger={warn(){},debug(){},info(){}};"
                    : "export const buildModelConfigMissingUiError=()=>({code:'model_config_missing'});",
            }));
          },
        },
      ],
    });
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => window.qa?.set);
    const state = () => page.locator("#state").evaluate((e) => JSON.parse(e.textContent));
    const pending = (n) => page.waitForFunction((n) => window.qa.pending.length === n, n);
    const set = (change) => page.evaluate((change) => window.qa.set(change), change);
    const resolve = (n, available = true) =>
      page.evaluate(
        ({ n, available }) =>
          window.qa.pending[n].resolve({
            providers: available ? [{ models: [{}] }] : [],
            revision: n,
          }),
        { n, available },
      );
    const allowed = (value) =>
      page.waitForFunction(
        (value) => JSON.parse(document.getElementById("state").textContent).allowed === value,
        value,
      );
    const creates = () =>
      page.evaluate(() => window.qa.commands.filter((x) => x === "createSession").length);
    const firstRenderBlocked = async (round) =>
      assert.equal(
        await page.evaluate(
          (round) => window.qa.renders.find((r) => r.round === round).allowed,
          round,
        ),
        false,
      );

    await set({ sessionId: null, round: 1 });
    await pending(1);
    await firstRenderBlocked(1);
    assert.equal(await creates(), 0);
    await resolve(0);
    await allowed(true);
    await page.waitForFunction(() => window.qa.commands.includes("createSession"));
    assert.equal(await creates(), 1);
    await set({ sessionId: "existing", round: 2 });
    await page.waitForFunction(() => window.qa.listeners[0].size === 0);
    await set({ sessionId: null, round: 3 });
    await pending(2);
    await firstRenderBlocked(3);
    assert.equal(await creates(), 1);
    // 切 workspace 后旧请求迟到，不能提前启动新 workspace。
    await set({ workspacePath: "D:/other", round: 4 });
    await pending(3);
    await firstRenderBlocked(4);
    await resolve(1);
    assert.equal((await state()).allowed, false);
    await resolve(2);
    await allowed(true);
    // 同一路径换 service 也必须重新校验，不沿用 ready。
    await set({ service: 1, round: 5 });
    await pending(4);
    await firstRenderBlocked(5);
    await page.evaluate(() => {
      for (const f of window.qa.listeners[1]) f({ providers: [], revision: 99 });
    });
    await resolve(3);
    await allowed(false);
    assert.equal((await state()).error, "model_config_missing");
    // 校验失败保持既有 Host 兜底；发送仍重新检查，未配置模型不能发送。
    await set({ provider: "zcode-alt", round: 6 });
    await pending(5);
    await firstRenderBlocked(6);
    await page.evaluate(() => window.qa.pending[4].reject(new Error("registry unavailable")));
    await allowed(true);
    await page.evaluate(() => {
      window.qa.send = window.qa.gate.ensureReadyForSend();
    });
    await pending(6);
    await resolve(5, false);
    assert.equal(await page.evaluate(() => window.qa.send), false);
    await allowed(false);
    // 旧草稿发送前复查迟到，不能把新草稿的 ready 覆盖成旧 activation。
    await page.evaluate(() => {
      window.qa.oldSend = window.qa.gate.ensureReadyForSend();
    });
    await pending(7);
    await set({ sessionId: "existing", round: 7 });
    await page.waitForFunction(() => window.qa.listeners[1].size === 0);
    await set({ sessionId: null, round: 8 });
    await pending(8);
    await firstRenderBlocked(8);
    await resolve(7);
    await allowed(true);
    await resolve(6, false);
    assert.equal(await page.evaluate(() => window.qa.oldSend), false);
    assert.equal((await state()).allowed, true);
  } finally {
    await browser?.close();
  }
});
