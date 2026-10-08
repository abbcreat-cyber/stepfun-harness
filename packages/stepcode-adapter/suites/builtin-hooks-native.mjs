import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { projectedClient } from "./provider-wire-fixtures.mjs";
import { StepStreamProjection } from "../src/stream-projection.mjs";

test("same native SDK rereads both managed hooks on each turn without adding user tasks", {
  skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for native hooks", timeout: 30000,
}, async t => {
  let f, phase = 0, batch = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ phase, body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "hook-turn", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (batch++ === 0) {
      send({ tool_calls: [{ index: 0, id: `tool-${phase}`, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: `"${process.execPath.replaceAll("\\", "/")}" "${join(f.root, "marker.mjs").replaceAll("\\", "/")}"` }) } }] }); send({}, "tool_calls");
    } else { send({ role: "assistant", content: "LOCAL_DONE" }); send({}, "stop"); }
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f = await projectedClient("openai-chat-completions", `http://127.0.0.1:${server.address().port}/v1`);
  const marker = join(f.root, "executed.txt");
  await writeFile(marker, "");
  await writeFile(join(f.root, "marker.mjs"), `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'x');`);
  const client = new StepCodeRpcClient({ command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions", "--extension", fileURLToPath(new URL("../src/extensions/desktop-task-contracts.mjs", import.meta.url))], cwd: f.root,
    env: { ...f.env, STEPCODE_TASK_MODE: "desktop", STEP_DISABLE_CRON: "1", STEPCODE_STORAGE_ROOT_DIR: f.root }, onUiRequest: () => ({ confirmed: true }) });
  t.after(async () => { await client.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await client.start(); await client.setModel(f.providerId, f.modelId);
  const pid = client.child.pid;
  for (const enabled of [true, false, true]) {
    await writeFile(join(f.root, "desktop-hooks.json"), JSON.stringify({ version: 1, enabled: { "first-principles": enabled, "opening-explanation": enabled } }));
    batch = 0; const prompt = `检查测试文件 ${phase}`;
    const events = await client.promptAndWait(prompt);
    const request = requests.find(r => r.phase === phase).body;
    const system = JSON.stringify(request.messages.filter(m => ["system", "developer"].includes(m.role)));
    assert.equal(system.includes("<desktop_first_principles>"), enabled);
    const user = request.messages.filter(m => m.role === "user").at(-1).content;
    assert.equal(typeof user === "string" ? user : user.map(p => p.text ?? "").join(""), prompt);
    const end = events.find(e => e.type === "tool_execution_end");
    assert.equal(end.isError, enabled, "enabled gate blocks silent tools; disabled gate executes them");
    assert.equal(client.child.pid, pid);
    phase++;
  }
  assert.equal(await readFile(marker, "utf8"), "x", "only disabled-hook turn executes");
  assert.equal(requests.length, 6);
  await writeFile(join(f.root, "desktop-hooks.json"), "BROKEN"); batch = 0;
  const rows = [], projection = new StepStreamProjection(rows, "corrupt", f.modelId);
  client.onEvent(event => projection.handle(event));
  await client.promptAndWait("检查损坏配置");
  assert.equal(projection.outcome, "failed");
  assert.equal(await readFile(marker, "utf8"), "x");
  assert.equal(requests.length, 7, "corrupt configuration stops without retry");
});
