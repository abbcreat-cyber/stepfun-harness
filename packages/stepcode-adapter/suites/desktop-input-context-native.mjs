import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { projectedClient, httpFixture } from "./provider-wire-fixtures.mjs";

test("real SDK sends actual user question last, prunes legacy rule without changing history, and resolves enabled PDF mention", {
  skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for native context capture", timeout: 45000,
}, async t => {
  const http = await httpFixture("openai-chat-completions");
  const f = await projectedClient("openai-chat-completions", http.baseUrl);
  const existingRule = "EXISTING_USER_RULE_METHOD_ONLY 从第一性原理出发解决问题。";
  await mkdir(join(f.root, "agent"), { recursive: true });
  await writeFile(join(f.root, "agent/AGENTS.md"), existingRule);
  const plugin = join(f.root, "plugins/pdf");
  const skillPath = join(plugin, "skills/pdf/SKILL.md");
  await mkdir(join(plugin, "skills/pdf"), { recursive: true });
  await writeFile(skillPath, "---\nname: step-builtin-pdf-pdf\ndescription: Make or read PDF documents.\n---\nLOCAL_SKILL_BODY\n");
  await writeFile(join(plugin, "step.plugin.json"), JSON.stringify({ id: "pdf", name: "PDF", stepOfficial: true, skills: ["skills"], mcpServers: {} }));
  const legacyExtension = join(f.root, "legacy-rule-seed.mjs");
  await writeFile(legacyExtension, `export default function(pi) {
pi.on('session_start', (_, ctx) => ctx.sessionManager.appendCustomMessageEntry('first-principles','LEGACY_RULE_READ_SOURCE_MUST_NOT_BE_SENT',false));
}`);
  const oldHook = join(f.root, "old-rule-hook.mjs");
  await writeFile(oldHook, `export default function(pi) {
pi.on('before_agent_start', () => ({message:{customType:'first-principles',display:false,content:'OLD_RULE_SOURCE_CHECK_REQUEST'}}));
}`);
  let client;
  t.after(async () => {
    await client?.stop(); await http.close();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const evidence = [];
  // 复现旧 SDK 扩展接线：隐藏 custom 提醒在 HTTP 中成为最后一个 user 消息。
  client = new StepCodeRpcClient({
    command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions", "--extension", oldHook],
    cwd: f.root, env: f.env,
  });
  await client.start(); await client.setModel(f.providerId, f.modelId);
  http.set({ kind: "text", text: "LOCAL_BASELINE_REPLY" });
  const originalPrompt = "[@PDF](plugin://pdf@zcode-plugins-official) 打开";
  await client.promptAndWait(originalPrompt);
  const before = http.requests.at(-1).body.messages.filter(message => message.role === "user").at(-1);
  const beforeText = typeof before.content === "string" ? before.content : before.content.filter(part => part.type === "text").map(part => part.text).join("");
  assert.ok(beforeText.includes("OLD_RULE_SOURCE_CHECK_REQUEST"));
  assert.notEqual(beforeText, originalPrompt, "baseline must reproduce the displaced user question");
  await client.stop();
  evidence.push({ state: "old-hook-baseline", prompt: originalPrompt, actualUserLast: false, injectedRuleLast: true });
  for (const state of ["enabled", "disabled"]) {
    if (state === "disabled") await rename(join(plugin, "step.plugin.json"), join(plugin, "step.plugin.disabled.json"));
    client = new StepCodeRpcClient({
      command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions",
        "--extension", legacyExtension,
        "--extension", fileURLToPath(new URL("../src/first-principles-hook.mjs", import.meta.url)),
        "--extension", fileURLToPath(new URL("../src/extensions/desktop-task-contracts.mjs", import.meta.url))],
      cwd: f.root, env: { ...f.env, STEPCODE_TASK_MODE: "desktop", STEP_DISABLE_CRON: "1", STEPCODE_STORAGE_ROOT_DIR: f.root },
    });
    await client.start(); await client.setModel(f.providerId, f.modelId);
    http.set({ kind: "text", text: "LOCAL_CONTEXT_REPLY" });
    const commands = await client.getCommands();
    if (state === "enabled") assert.ok(commands.some(command => command.name === "skill:step-builtin-pdf-pdf"), "PDF skill must actually be loaded by SDK");
    for (const prompt of ["随便问个问题：7加5是多少？", "[@PDF](plugin://pdf@zcode-plugins-official) 打开"]) {
      await client.promptAndWait(prompt);
      const request = http.requests.at(-1).body;
      const system = request.messages.filter(message => ["system", "developer"].includes(message.role)).map(message => message.content).join("\n");
      assert.ok(system.includes(existingRule));
      assert.ok(!system.includes("查找钩子源码"));
      assert.ok(!JSON.stringify(request).includes("LEGACY_RULE_READ_SOURCE_MUST_NOT_BE_SENT"));
      const lastUser = request.messages.filter(message => message.role === "user").at(-1);
      assert.equal(typeof lastUser.content === "string" ? lastUser.content : lastUser.content.filter(part => part.type === "text").map(part => part.text).join(""), prompt);
      if (prompt.startsWith("[@PDF]")) {
        assert.ok(system.includes('"installed":true'));
        assert.ok(system.includes(`"enabled":${state === "enabled"}`));
        assert.ok(system.includes(`"loaded":${state === "enabled"}`));
        if (state === "enabled") assert.ok(system.includes("step-builtin-pdf-pdf"));
        assert.equal(system.includes("LOCAL_SKILL_BODY"), state === "enabled", "selected native skill body must reach the actual model request only while enabled");
      } else assert.ok(!system.includes("本轮引用插件的事实"));
      evidence.push({ state, prompt, actualUserLast: true, ruleOnlyInSystem: true, legacyRuleFiltered: true });
    }
    const { entries } = await client.getEntries();
    assert.ok(entries.some(entry => entry.type === "custom_message" && entry.content === "LEGACY_RULE_READ_SOURCE_MUST_NOT_BE_SENT"), "original history retained");
    assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "first-principles").length, 1, "no new custom rule tasks stored");
    await client.stop();
  }
  if (process.env.STEP_WIRE_EVIDENCE_DIR) await writeFile(join(process.env.STEP_WIRE_EVIDENCE_DIR, "input-context-native.json"), JSON.stringify({ pass: true, evidence, localRequests: http.requests.length }, null, 2));
});
