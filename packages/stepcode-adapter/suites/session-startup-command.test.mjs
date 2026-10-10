import test from "node:test";
import assert from "node:assert/strict";
import { sessionStartupCommand } from "../src/session-startup-command.mjs";
import { httpFixture, projectedClient } from "./provider-wire-fixtures.mjs";
import { prepareProviderRequestOptions } from "../src/provider-request-options.mjs";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
test("冷恢复使用一个明确原生文件，新会话不改变原启动参数", () => {
  const cmd = ["step.exe", "--mode", "rpc", "--no-session", "--session", "old.jsonl", "--extension", "hook.mjs"];
  assert.equal(sessionStartupCommand(cmd), cmd);
  assert.deepEqual(sessionStartupCommand(cmd, "D:/中文 空格/new.jsonl"), ["step.exe", "--mode", "rpc", "--extension", "hook.mjs", "--session", "D:/中文 空格/new.jsonl"]);
});
test("真实冷启动直接加载原会话，不需要 switch_session 二次重载", { skip: !process.env.STEP_TEST_CLI, timeout: 30000 }, async () => {
  const http = await httpFixture("openai-chat-completions"), f = await projectedClient("openai-chat-completions", http.baseUrl);let restored;
  f.client.options.command = f.client.options.command.filter(x => x !== "--no-session");
  try {
    await f.client.start(); await f.client.setModel(f.providerId, f.modelId);
    await prepareProviderRequestOptions(f.client, { providerId: f.providerId, modelId: f.modelId, options: { reasoningLevel: "low" } });
    await f.client.promptAndWait("COLD_HISTORY_KEEP", { timeoutMs: 15000 });
    const state = await f.client.getState(); await f.client.stop();
    restored = new StepCodeRpcClient({ ...f.client.options, command: sessionStartupCommand(f.client.options.command, state.sessionFile) });
    await restored.start(); const after = await restored.getState();
    assert.equal(after.sessionFile, state.sessionFile);
    assert.ok(JSON.stringify((await restored.request({ type: "get_messages" })).data).includes("COLD_HISTORY_KEEP"));
  } finally { await restored?.stop(); await f.client.stop(); await http.close(); }
});
