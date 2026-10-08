import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { StepStreamProjection } from "../src/stream-projection.mjs";
import { projectedClient } from "./provider-wire-fixtures.mjs";
import { OPENING_REQUIRED, OPENING_STOPPED } from "../src/assistant-opening-hook.mjs";

for (const scenario of ["repair", "silent", "optout", "plugin"]) test(`native opening/plugin preflight: ${scenario}`, {
  skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for real preflight", timeout: 30000,
}, async t => {
  let f, step = 0;
  const requests = [], errors = [];
  const exists = async path => { try { await access(path); return true; } catch { return false; } };
  const markers = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      const current = step++;
      if (current === 1 && scenario !== "optout") for (const marker of markers) assert.equal(await exists(marker), false, "preflight allowed a side effect");
      if (scenario === "repair" && current === 1) assert.ok(JSON.stringify(body).includes(OPENING_REQUIRED));
      if (scenario === "plugin" && current === 1) {
        assert.ok(JSON.stringify(body).includes("plugin:// 是应用插件引用"));
        assert.ok(JSON.stringify(body).includes('\\"installed\\":true'));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: `s${current}`, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const tools = current === 0 || (current === 1 && ["repair", "silent"].includes(scenario));
      if (tools) {
        if (scenario === "plugin" || (scenario === "repair" && current === 1)) send({ role: "assistant", content: "我先核对你指定的内容，再确认结果。" });
        const calls = scenario === "plugin" ? [{ name: "browser_navigate", args: { url: "plugin://pdf@zcode-plugins-official" } }] : markers.map(path => ({ name: "run_command", args: { command: `"${process.execPath.replaceAll("\\", "/")}" "${join(f.root, "write-marker.mjs").replaceAll("\\", "/")}" "${path.replaceAll("\\", "/")}"` } }));
        send({ tool_calls: calls.map((call, index) => ({ index, id: `call_${current}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
        send({}, "tool_calls");
      } else { send({ role: "assistant", content: "LOCAL_DONE" }); send({}, "stop"); }
      res.end("data: [DONE]\n\n");
    } catch (error) { errors.push(error.message); res.writeHead(400).end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f = await projectedClient("openai-chat-completions", `http://127.0.0.1:${server.address().port}/v1`);
  markers.push(join(f.root, "marker-a"), join(f.root, "marker-b"));
  await writeFile(join(f.root, "write-marker.mjs"), "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2], 'executed\\n');");
  const pluginRoot = join(f.root, "plugins/pdf");
  await mkdir(join(pluginRoot, "skills/pdf"), { recursive: true });
  await writeFile(join(pluginRoot, "step.plugin.json"), JSON.stringify({ id: "pdf", name: "PDF", stepOfficial: true, skills: ["skills"] }));
  await writeFile(join(pluginRoot, "skills/pdf/SKILL.md"), "---\nname: fixture-pdf\ndescription: Read PDFs\n---\nFixture PDF guidance");
  const extension = join(f.root, "browser-fixture.mjs");
  await writeFile(extension, `import { writeFile } from 'node:fs/promises'; export default function(pi) {pi.registerTool({name:'browser_navigate',label:'browser',description:'Isolated browser fixture',parameters:{type:'object',properties:{url:{type:'string'}},required:['url']},async execute(){await writeFile(${JSON.stringify(markers[0])},'executed'); return {content:[{type:'text',text:'unexpected execution'}]};}});}`);
  const client = new StepCodeRpcClient({
    command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions", "--extension", extension,
      "--extension", fileURLToPath(new URL("../src/extensions/desktop-task-contracts.mjs", import.meta.url))],
    env: { ...f.env, STEPCODE_TASK_MODE: "desktop", STEP_DISABLE_CRON: "1", STEPCODE_STORAGE_ROOT_DIR: f.root },
    cwd: f.root, onUiRequest: () => ({ confirmed: true }),
  });
  const rows = [], projection = new StepStreamProjection(rows, "opening", f.modelId);
  client.onEvent(event => projection.handle(event));
  t.after(async () => { await client.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await client.start(); await client.setModel(f.providerId, f.modelId);
  const events = await client.promptAndWait(scenario === "optout" ? "只给结果" : "检查指定内容", { timeoutMs: 20000 });
  assert.deepEqual(errors, []);
  assert.ok(events.some(event => event.type === "agent_settled"));
  if (["repair", "optout"].includes(scenario)) for (const path of markers) assert.equal(await readFile(path, "utf8"), "executed\n");
  else for (const path of markers) assert.equal(await exists(path), false);
  assert.equal(requests.length, scenario === "repair" ? 3 : 2);
  if (scenario === "silent") {
    assert.ok(events.some(event => event.type === "tool_execution_end" && JSON.stringify(event.result).includes(OPENING_STOPPED)));
    assert.equal(projection.outcome, "failed");
    assert.equal(rows.filter(row => row.state === "failed" && row.text?.includes("本轮已停止")).length, 1);
  }
  if (["silent", "repair"].includes(scenario)) assert.ok(rows.some(row => row.kind === "toolCall" && row.status === "cancelled" && !row.error));
  if (process.env.STEP_WIRE_EVIDENCE_DIR) await writeFile(join(process.env.STEP_WIRE_EVIDENCE_DIR, `opening-${scenario}.json`), JSON.stringify({ pass: true, scenario, localRequests: requests.length, toolStatuses: rows.filter(row => row.kind === "toolCall").map(row => row.status), actualExecutions: ["repair", "optout"].includes(scenario) ? 2 : 0 }, null, 2));
});
