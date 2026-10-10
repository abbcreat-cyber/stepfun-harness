import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { projectedClient, httpFixture } from "./provider-wire-fixtures.mjs";

test("native hidden discovery must not displace the actual user request", { skip: !process.env.STEP_TEST_CLI, timeout: 45000 }, async t => {
  const http = await httpFixture("openai-chat-completions");
  const f = await projectedClient("openai-chat-completions", http.baseUrl);
  let client;
  t.after(async () => { await client?.stop(); await http.close(); await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const prompt = "ADMIN_TEST 这是待删除的临时测试会话，只回答 ADMIN_READY。";
  const userText = message => typeof message.content === "string" ? message.content : message.content.filter(p => p.type === "text").map(p => p.text).join("");
  for (const fixed of [false, true]) {
    client = new StepCodeRpcClient({ command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions",
      ...(fixed ? ["--extension", fileURLToPath(new URL("../src/extensions/desktop-task-contracts.mjs", import.meta.url))] : [])],
      cwd: f.root, env: { ...f.env, STEPCODE_TASK_MODE: fixed ? "desktop" : "native-baseline", STEP_DISABLE_CRON: "1", STEPCODE_STORAGE_ROOT_DIR: f.root },
    });
    await client.start(); await client.setModel(f.providerId, f.modelId);
    http.set({ kind: "text", text: "ADMIN_READY" }); await client.promptAndWait(prompt);
    const users = http.requests.at(-1).body.messages.filter(m => m.role === "user");
    assert.ok(users.some(m => userText(m).includes("Ultracode and Ultraloop")));
    if (fixed) {
      assert.equal(userText(users.at(-1)), prompt);
      const system = http.requests.at(-1).body.messages.filter(m => m.role === "system" || m.role === "developer").map(userText).join("\n");
      assert.match(system, /desktop_input_origin/);
    }
    else assert.match(userText(users.at(-1)), /Ultracode and Ultraloop/);
    const { entries } = await client.getEntries();
    assert.ok(entries.some(e => e.type === "custom_message" && e.customType === "ultraloop-discovery"));
    await client.stop();
  }
});
