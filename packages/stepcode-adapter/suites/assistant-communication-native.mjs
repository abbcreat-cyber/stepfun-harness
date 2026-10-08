import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { StepStreamProjection } from "../src/stream-projection.mjs";
import { visibleConversationRows } from "../src/assistant-text.mjs";
import { withDefaultLanguage } from "../src/default-language.mjs";
import { COMMUNICATION_POLICY_MARKER } from "../src/assistant-communication.mjs";
import { projectedClient, httpFixture, protocols } from "./provider-wire-fixtures.mjs";

const native = { skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for native communication capture", timeout: 45000 };
function makeClient(f) {
  return new StepCodeRpcClient({
    command: withDefaultLanguage([process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions"]),
    env: { ...f.env, STEPCODE_TASK_MODE: "desktop", STEP_DISABLE_CRON: "1" },
    cwd: f.root, onUiRequest: () => ({ confirmed: true }),
  });
}

for (const protocol of protocols) test(`global communication policy reaches both turns once (${protocol})`, native, async t => {
  const http = await httpFixture(protocol);
  const f = await projectedClient(protocol, http.baseUrl);
  const client = makeClient(f);
  t.after(async () => { await client.stop(); await http.close(); await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await client.start(); await client.setModel(f.providerId, f.modelId);
  http.set({ kind: "text", text: "LOCAL_TEST_REPLY" });
  for (const prompt of ["核对这个示例文件", "第二个独立请求，只给结果"]) {
    await client.promptAndWait(prompt);
    const payload = JSON.stringify(http.requests.at(-1).body);
    assert.equal(payload.split(COMMUNICATION_POLICY_MARKER).length - 1, 1);
    assert.ok(payload.includes("开始实际操作前"));
    assert.ok(payload.includes("连续约 3 批工具调用"));
    assert.ok(payload.includes("用户明确的只给结果"));
  }
  assert.equal(http.requests.length, 2, "progress rules must not cause extra model requests");
});

test("real SDK opening, obstacle, finding and final prose stream before tools and survive replay", native, async t => {
  const prose = [
    "我先检查指定文件，确认内容后再给你结果。",
    "指定路径没有文件。我会核对工作区里已经提供的文件。",
    "已读到有效内容，接下来核对第二份资料是否一致。",
    "两份资料已核对，结果一致。原先的路径没有文件。",
  ];
  let stage = 0, f;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const index = stage++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: `stage-${index}`, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: "assistant", content: prose[index].slice(0, 5) });
    send({ content: prose[index].slice(5) });
    if (index < 3) {
      const path = join(f.root, index === 0 ? "missing.txt" : index === 1 ? "one.txt" : "two.txt");
      send({ tool_calls: [{ index: 0, id: `read-${index}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }] });
      send({}, "tool_calls");
    } else send({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f = await projectedClient(protocols[0], `http://127.0.0.1:${server.address().port}/v1`);
  await mkdir(f.root, { recursive: true });
  await writeFile(join(f.root, "one.txt"), "SAME_CONTENT"); await writeFile(join(f.root, "two.txt"), "SAME_CONTENT");
  const client = makeClient(f), rows = [], snapshots = [], toolOrder = [];
  const projection = new StepStreamProjection(rows, "communication-turn", f.modelId);
  client.onEvent(event => {
    projection.handle(event);
    if (event.type === "tool_execution_start") snapshots.push(visibleConversationRows(structuredClone(rows)));
    if (event.type === "tool_execution_end") toolOrder.push(event.isError === true);
  });
  t.after(async () => { await client.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await client.start(); await client.setModel(f.providerId, f.modelId);
  await client.promptAndWait("核对指定文件并说明进展");
  assert.deepEqual(toolOrder, [true, false, false]);
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(snapshots[index].filter(row => row.kind === "assistantText").map(row => row.text), prose.slice(0, index + 1));
  }
  const replay = visibleConversationRows(JSON.parse(JSON.stringify(rows)));
  assert.deepEqual(replay.filter(row => row.kind === "assistantText").map(row => row.text), prose);
  assert.equal(new Set(replay.filter(row => row.kind === "assistantText").map(row => row.rowId)).size, 4);
  assert.ok(!JSON.stringify(replay).includes("本轮已结束"));
  assert.equal(requests.length, 4, "only native tool continuation requests are allowed");
  if (process.env.STEP_WIRE_EVIDENCE_DIR) await writeFile(join(process.env.STEP_WIRE_EVIDENCE_DIR, "communication-native.json"), JSON.stringify({ pass: true, nativeRequests: requests.length, prose, beforeToolTextCounts: snapshots.map(snapshot => snapshot.filter(row => row.kind === "assistantText").length), toolErrors: toolOrder, replayTextCount: 4 }, null, 2));
});
