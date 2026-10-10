import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { projectedClient } from "./provider-wire-fixtures.mjs";
import { CHECKPOINT, checkpointPreview, checkpointsFor, applyCheckpoints } from "../src/file-checkpoints.mjs";

test("真实底座先拦截开场再写文件，只有真实写入生成可撤销 checkpoint", { skip: !process.env.STEP_TEST_CLI, timeout: 30000 }, async () => {
  let fixture, count = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the local fixture request */ }
    const current = count++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `response-${current}`, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (current < 2) {
      if (current === 1) send({ role: "assistant", content: "先修改文件，再核对结果。" });
      send({ tool_calls: [{ index: 0, id: `write-${current}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: fixture.root + "/sample.txt", content: "after" }) } }] });
      send({}, "tool_calls");
    } else { send({ role: "assistant", content: "done" }); send({}, "stop"); }
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fixture = await projectedClient("openai-chat-completions", `http://127.0.0.1:${server.address().port}/v1`);
  await writeFile(fixture.root + "/sample.txt", "before");
  const client = new StepCodeRpcClient({
    command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions", "--extension", fileURLToPath(new URL("../src/extensions/desktop-task-contracts.mjs", import.meta.url)), "--approval-mode", "auto"],
    env: { ...fixture.env, STEPCODE_TASK_MODE: "desktop", STEP_DISABLE_CRON: "1", STEPCODE_STORAGE_ROOT_DIR: fixture.root }, cwd: fixture.root,
  });
  try {
    await client.start(); await client.setModel(fixture.providerId, fixture.modelId);
    await client.promptAndWait("修改指定文件", { timeoutMs: 20000 });
    assert.equal(count, 3);
    assert.equal(await readFile(fixture.root + "/sample.txt", "utf8"), "after");
    const { data: { entries } } = await client.request({ type: "get_entries" });
    const records = entries.filter(e => e.customType === CHECKPOINT);
    assert.equal(records.length, 2);
    assert.ok(records.every(e => e.data.toolCallId === "write-1" && !e.data.overlap));
    const files = checkpointsFor(entries, records[0].data.userId);
    assert.equal((await checkpointPreview(files)).canApply, true);
    assert.equal((await applyCheckpoints(files)).applied, true);
    assert.equal(await readFile(fixture.root + "/sample.txt", "utf8"), "before");
  } finally {
    await client.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
