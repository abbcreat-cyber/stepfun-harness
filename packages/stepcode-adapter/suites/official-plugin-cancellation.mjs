import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once, EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { officialPluginSource } from "../src/official-plugins.mjs";

// 真正启动 wrapper 和其下游 stdio MCP；fixture 仅报告收到的协议与可控副作用。
const fixtureServer = `
const {createInterface}=require('node:readline');
const pending=new Map();
const report=(event)=>fetch(process.env.FIXTURE_RELAY+'/event',{method:'POST',body:JSON.stringify(event)});
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(f.method==='initialize') reply(f.id,{protocolVersion:f.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'cancellation-fixture',version:'1'}});
 if(f.method==='tools/list') reply(f.id,{tools:[{name:'wait',inputSchema:{type:'object',properties:{}}}]});
 if(f.method==='tools/call') {
  const token=f.params.arguments.token;
  const timer=setTimeout(()=>{pending.delete(f.id);report({kind:'finished',token});reply(f.id,{content:[{type:'text',text:token}]});},f.params.arguments.delay??50);
  pending.set(f.id,{timer,token});report({kind:'started',token});
 }
 if(f.method==='notifications/cancelled') {
  const item=pending.get(f.params.requestId);
  if(item){clearTimeout(item.timer);pending.delete(f.params.requestId);report({kind:'cancelled',token:item.token});}
 }
});
`;

async function harness(t, native = false) {
  const root = await mkdtemp(
    join(fileURLToPath(new URL("../../../", import.meta.url)), ".cancel-test-"),
  );
  const events = [],
    frames = [],
    emitter = new EventEmitter();
  let holdContext = false;
  const held = [];
  const relay = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const data = JSON.parse(raw);
    if (req.url === "/event") {
      events.push(data);
      emitter.emit("change");
      res.end("{}");
      return;
    }
    const result =
      data.method === "context"
        ? {
            sessionId: "cancel-fixture",
            turnId: "turn-fixture",
            workspacePath: root,
            workspaceKey: root,
            clientMode: "desktop-continuous",
          }
        : { ok: true };
    const respond = () =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    if (data.method === "browserList") {
      events.push({ kind: "browser-held", params: data.params });
      res.on("close", () => {
        events.push({ kind: "browser-closed" });
        emitter.emit("change");
      });
      emitter.emit("change");
    } else if (data.method === "context" && holdContext) {
      held.push(respond);
      events.push({ kind: "context-held" });
      emitter.emit("change");
    } else respond();
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${relay.address().port}`;
  await mkdir(join(root, "dist/mcp"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"commonjs"}');
  await mkdir(join(root, "browser-bridges"), { recursive: true });
  await writeFile(join(root, "dist/mcp/server.js"), fixtureServer);
  await writeFile(
    join(root, "step-official-runtime.json"),
    JSON.stringify({
      plugin: "cancel-fixture",
      servers: {
        fixture: { type: "stdio", protocolVersion: "legacy", env: { FIXTURE_RELAY: endpoint } },
      },
    }),
  );
  if (native) {
    await cp(join(officialPluginSource(), "node-repl-host"), join(root, "plugins/node-repl-host"), {
      recursive: true,
    });
    await writeFile(
      join(root, "step-official-runtime.json"),
      JSON.stringify({ plugin: "browser-use", servers: { fixture: { _nodeRepl: true } } }),
    );
  }
  await writeFile(
    join(root, "browser-bridges", `${process.pid}.json`),
    JSON.stringify({ endpoint: `${endpoint}/execute`, token: "fixture" }),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../bin/official-plugin-mcp.mjs", import.meta.url)),
      "--plugin-root",
      root,
      "--mcp-name",
      "fixture",
    ],
    {
      cwd: root,
      env: { ...process.env, STEPCODE_STORAGE_ROOT_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    frames.push(JSON.parse(line));
    emitter.emit("change");
  });
  const waitFor = (predicate) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const value = predicate();
        if (value) {
          cleanup();
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `MCP observation timeout: ${stderr.slice(-1200)} ${JSON.stringify({ events, frames })}`,
          ),
        );
      }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        emitter.off("change", check);
      };
      emitter.on("change", check);
      check();
    });
  const send = (frame) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  const request = (id, method, params = {}) => {
    send({ id, method, params });
    return waitFor(() => frames.find((f) => f.id === id));
  };
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.stdin.end();
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error("wrapper failed to close")), 5000);
        timer.unref();
        exited.finally(() => clearTimeout(timer));
      }),
    ]);
  };
  t.after(async () => {
    await stop().catch(() => child.kill());
    relay.closeAllConnections();
    await new Promise((r) => relay.close(r));
    await rm(root, { recursive: true, force: true });
  });
  assert.ok(
    (
      await request("init", "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      })
    ).result,
  );
  send({ method: "notifications/initialized" });
  const listed = await request("list", "tools/list");
  assert.ok(listed.result, JSON.stringify(listed) + stderr);
  return {
    send,
    request,
    waitFor,
    frames,
    events,
    stop,
    endpoint,
    hold: () => {
      holdContext = true;
    },
    release: () => {
      holdContext = false;
      for (const respond of held.splice(0)) respond();
    },
  };
}

test(
  "official MCP forwards cancellation with typed request isolation and no notification response",
  { timeout: 20000 },
  async (t) => {
    const h = await harness(t);
    h.send({
      id: 0,
      method: "tools/call",
      params: { name: "wait", arguments: { token: "cancel-me", delay: 1500 } },
    });
    h.send({
      id: "0",
      method: "tools/call",
      params: { name: "wait", arguments: { token: "keep-me", delay: 150 } },
    });
    await h.waitFor(() => h.events.some((e) => e.kind === "started" && e.token === "cancel-me"));
    h.send({ method: "notifications/cancelled", params: { requestId: 0, reason: "Stop" } });
    await h.waitFor(() => h.events.some((e) => e.kind === "cancelled" && e.token === "cancel-me"));
    assert.equal(
      (await h.waitFor(() => h.frames.find((f) => f.id === "0"))).result.content[0].text,
      "keep-me",
    );
    for (const requestId of [0, "0", "unknown", "init"])
      h.send({ method: "notifications/cancelled", params: { requestId } });
    assert.ok(
      (await h.request("after", "tools/call", { name: "wait", arguments: { token: "after" } }))
        .result,
    );
    assert.ok(!h.events.some((e) => e.kind === "finished" && e.token === "cancel-me"));
    assert.ok(!h.frames.some((f) => f.id === 0 || f.id === undefined));
  },
);

test(
  "official MCP cancellation while context is pending prevents later tool dispatch",
  { timeout: 20000 },
  async (t) => {
    const h = await harness(t);
    h.hold();
    h.send({
      id: "held",
      method: "tools/call",
      params: { name: "wait", arguments: { token: "must-not-run" } },
    });
    await h.waitFor(() => h.events.some((e) => e.kind === "context-held"));
    h.send({ method: "notifications/cancelled", params: { requestId: "held" } });
    await h.request("barrier", "ping");
    h.release();
    await h.request("after", "tools/call", {
      name: "wait",
      arguments: { token: "after", delay: 100 },
    });
    assert.ok(!h.events.some((e) => e.token === "must-not-run"));
    assert.ok(!h.frames.some((f) => f.id === "held" || f.id === undefined));
  },
);

test(
  "official MCP EOF closes an active operation and releases the wrapper",
  { timeout: 20000 },
  async (t) => {
    const h = await harness(t);
    h.send({
      id: "close",
      method: "tools/call",
      params: { name: "wait", arguments: { token: "close-me", delay: 10000 } },
    });
    await h.waitFor(() => h.events.some((e) => e.kind === "started" && e.token === "close-me"));
    await h.stop();
    assert.ok(!h.events.some((e) => e.kind === "finished" && e.token === "close-me"));
  },
);

test(
  "original Node Repl cancels real execution, accepts next js, and cancels browser relay with original turn",
  {
    timeout: 30000,
    skip: !existsSync(join(officialPluginSource(), "node-repl-host/dist/mcp/server.js")),
  },
  async (t) => {
    const h = await harness(t, true);
    const setup = `var http=await import('node:http');var timers=await import('node:timers/promises');var report=kind=>new Promise((resolve,reject)=>{var req=http.request(${JSON.stringify(h.endpoint + "/event")},{method:'POST'},res=>{res.resume();res.on('end',resolve)});req.on('error',reject);req.end(JSON.stringify({kind}));});`;
    h.send({
      id: "native-long",
      method: "tools/call",
      params: {
        name: "js",
        arguments: {
          title: "隔离取消验证",
          code:
            setup +
            "await report('native-started');await timers.setTimeout(2500);await report('native-finished');",
          timeout_ms: 10000,
        },
      },
    });
    await h.waitFor(() => h.events.some((e) => e.kind === "native-started"));
    h.send({ method: "notifications/cancelled", params: { requestId: "native-long" } });
    const started = Date.now();
    const next = await h.request("native-next", "tools/call", {
      name: "js",
      arguments: { code: "nodeRepl.write(42)", title: "取消后短调用" },
    });
    assert.ok(Date.now() - started < 2000, "next js must run before the cancelled delay ends");
    assert.notEqual(next.result?.isError, true, JSON.stringify(next));
    assert.ok(
      next.result?.content.some((c) => c.text?.includes("42")),
      JSON.stringify(next),
    );
    await delay(2600);
    assert.ok(!h.events.some((e) => e.kind === "native-finished"));
    assert.ok(!h.frames.some((f) => f.id === "native-long"));
    h.send({
      id: "native-browser",
      method: "tools/call",
      params: {
        name: "js",
        arguments: {
          title: "隔离浏览器取消验证",
          code: 'const bridge=globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")];await bridge.list()',
        },
      },
    });
    const browser = await h.waitFor(() => h.events.find((e) => e.kind === "browser-held"));
    assert.equal(browser.params.turnId, "turn-fixture");
    assert.equal(browser.params.sessionId, "cancel-fixture");
    h.send({ method: "notifications/cancelled", params: { requestId: "native-browser" } });
    await h.waitFor(() => h.events.some((e) => e.kind === "browser-closed"));
    assert.ok(
      (
        await h.request("native-after-browser", "tools/call", {
          name: "js",
          arguments: { code: "nodeRepl.write(43)", title: "浏览器取消后短调用" },
        })
      ).result?.content.some((c) => c.text?.includes("43")),
    );
  },
);
