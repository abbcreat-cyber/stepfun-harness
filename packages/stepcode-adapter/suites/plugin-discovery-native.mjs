import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { projectedClient } from "./provider-wire-fixtures.mjs";

test("native find_tools preserves zero matches and returns selected skill facts, next ordinary turn clears selection", {
  skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for native discovery", timeout: 30000,
}, async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "discovery", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (requests.length === 1) {
      send({ role: "assistant", content: "我先使用你选择的技能核对内容。" });
      send({ tool_calls: [{ index: 0, id: "discovery-call", type: "function", function: { name: "find_tools", arguments: JSON.stringify({ query: "unmatched_zz_fixture_capability" }) } }] });
      send({}, "tool_calls");
    } else { send({ role: "assistant", content: "LOCAL_DONE" }); send({}, "stop"); }
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const f = await projectedClient("openai-chat-completions", `http://127.0.0.1:${server.address().port}/v1`);
  const root = join(f.root, "plugins/presentations");
  await mkdir(join(root, "skills/pptx"), { recursive: true });
  await writeFile(join(root, "step.plugin.json"), JSON.stringify({ id: "presentations", stepOfficial: true, skills: ["skills"] }));
  await writeFile(join(root, "skills/pptx/SKILL.md"), "---\nname: fixture-slides\ndescription: Create slides\n---\nORIGINAL_SLIDES_ACTIVATED");
  const client = new StepCodeRpcClient({ command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions", "--extension", fileURLToPath(new URL("../src/extensions/desktop-task-contracts.mjs", import.meta.url))],
    cwd: f.root, env: { ...f.env, STEPCODE_TASK_MODE: "desktop", STEP_DISABLE_CRON: "1", STEPCODE_STORAGE_ROOT_DIR: f.root } });
  t.after(async () => { await client.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await client.start(); await client.setModel(f.providerId, f.modelId);
  const prompt = "请使用 [@演示文档](plugin://presentations@zcode-plugins-official) 做幻灯片";
  const events = await client.promptAndWait(prompt);
  const result = events.find(e => e.type === "tool_execution_end" && e.toolName === "find_tools");
  const output = JSON.stringify(result?.result);
  assert.ok(output.includes("no matching tools"), output);
  assert.ok(output.includes("installed\\\":true"), output);
  assert.ok(output.includes("零命中不代表未安装"), output);
  assert.ok(JSON.stringify(requests[0].messages.filter(m => m.role === "user")).includes("ORIGINAL_SLIDES_ACTIVATED"));
  assert.ok(requests[0].messages.filter(m => m.role === "user").some(m => (typeof m.content === "string" ? m.content : m.content.map(part => part.text ?? "").join("")) === prompt));
  await client.promptAndWait("普通问题");
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes("ORIGINAL_SLIDES_ACTIVATED"));
  assert.equal(requests.length, 3);
});
