import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {startEmbeddedBrowserRelay} from '../src/embedded-browser-relay.mjs';
test('embedded browser: only bound live session reaches iab; no external fallback',async()=>{const root=await mkdtemp(join(tmpdir(),'step-iab-'));let live=true;const calls=[];const relay=await startEmbeddedBrowserRelay({directory:root,getContext:pid=>live&&pid===321?{sessionId:'session-a',workspaceKey:'ws',workspacePath:'D:/work',clientMode:'desktop-continuous',sessionContext:'live'}:null,requestHost:async(method,params)=>{calls.push({method,params});if(method==='interaction/browserList')return {browsers:[{id:'iab-a',generation:4,type:'iab'}]};return {ok:true,state:{url:'https://example.com',title:'Example Domain'},elapsedMs:1};}});try{await relay.bindPid(321);const info=JSON.parse(await readFile(join(root,'321.json'),'utf8'));const execute=()=>fetch(info.endpoint,{method:'POST',headers:{authorization:`Bearer ${info.token}`},body:JSON.stringify({method:'navigate',url:'https://example.com'})});assert.equal((await (await execute()).json()).ok,true);assert.equal(calls[1].params.browserId,'iab-a');assert.equal(calls[1].params.browserGeneration,4);assert.equal(calls[1].params.sessionId,'session-a');live=false;assert.equal((await execute()).status,403);assert.equal(calls.length,2);}finally{await relay.close();await rm(root,{recursive:true,force:true});}});

async function mcpFixture(t, respond) {
  const root = await mkdtemp(join(fileURLToPath(new URL("../../../", import.meta.url)), ".snapshot-test-"));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(respond(JSON.parse(body))));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeFile(join(root, `${process.pid}.json`), JSON.stringify({
    endpoint: `http://127.0.0.1:${server.address().port}/execute`, token: "fixture-token",
  }));
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../bin/embedded-browser-mcp.mjs", import.meta.url)), "--bridge-dir", root,
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  const reader = createInterface({ input: child.stdout });
  reader.on("line", line => {
    const frame = JSON.parse(line);
    pending.get(frame.id)?.(frame.result);
  });
  t.after(async () => {
    reader.close();
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let sequence = 0;
  return async (name, args = {}) => {
    const id = ++sequence;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("fixture MCP deadline")); }, 5_000);
      pending.set(id, result => { clearTimeout(timer); pending.delete(id); resolve(result); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    });
  };
}

test("legacy snapshot MCP exposes readable lines while preserving the complete large result and refs", async t => {
  const snapshot = {
    url: "https://example.invalid/news",
    title: "News fixture",
    elements: Array.from({ length: 200 }, (_, index) => ({
      ref: `e${index + 1}`, tag: "a", role: "link", name: "Fixture headline",
      text: "Readable fixture body", selector: `#fixture-${index}`, xpath: `/html/body/a[${index + 1}]`,
      rect: { x: 0, y: index * 20, width: 100, height: 20 }, inViewport: index < 30,
      attributes: { href: `https://example.invalid/news/${index}`, "data-fixture": "x".repeat(250) },
    })),
    truncated: false,
    dom: [{ tag: "p", depth: 1, text: "Readable article fixture", inViewport: true }],
    domTruncated: false,
  };
  const payload = { ok: true, snapshot, elapsedMs: 7, meta: { browserId: "iab-fixture", browserGeneration: 4 } };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 87_407);
  const call = await mcpFixture(t, command => {
    assert.deepEqual(command, { method: "snapshot" });
    return payload;
  });
  const result = await call("browser_snapshot");
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.deepEqual(JSON.parse(text), payload);
  // SDK 按完整行裁剪时，原单行 87KB 输出第一屏为 0 行；多行结果可直接读标题和正文。
  let preview = "";
  for (const line of text.split("\n")) {
    if (Buffer.byteLength(`${preview}${line}\n`) > 4096) break;
    preview += `${line}\n`;
  }
  assert.ok(preview.split("\n").length > 1);
  assert.match(preview, /News fixture/);
  assert.match(preview, /https:\/\/example\.invalid\/news/);
  assert.match(preview, /Readable fixture body/);
  assert.match(preview, /"ref": "e1"/);
  assert.equal(JSON.parse(text).snapshot.elements.at(-1).ref, "e200");
  t.diagnostic(`snapshot compact=${Buffer.byteLength(JSON.stringify(payload))} bytes; formatted=${Buffer.byteLength(text)} bytes/${text.split("\n").length} lines; first preview=${Buffer.byteLength(preview)} bytes/${preview.trimEnd().split("\n").length} lines`);
});

test("legacy MCP keeps screenshot image blocks and real navigation timeout failures", async t => {
  const call = await mcpFixture(t, command => command.method === "screenshot"
    ? { ok: true, image: { base64: "fixture-image", mimeType: "image/png" }, elapsedMs: 1 }
    : { ok: false, error: { code: "timeout", message: "Navigation timed out after 10000ms" }, elapsedMs: 10_000 });
  const screenshot = await call("browser_screenshot");
  assert.deepEqual(screenshot.content[1], { type: "image", data: "fixture-image", mimeType: "image/png" });
  assert.deepEqual(JSON.parse(screenshot.content[0].text), { ok: true, elapsedMs: 1 });
  const failed = await call("browser_navigate", { url: "https://example.invalid/timeout" });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, "Navigation timed out after 10000ms");
});
