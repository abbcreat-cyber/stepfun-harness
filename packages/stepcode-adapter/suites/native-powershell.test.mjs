import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { activateNativePowerShell, unsafePowerShellNesting, nativePowerShellContract } from "../src/native-powershell.mjs";
import { httpFixture, projectedClient } from "./provider-wire-fixtures.mjs";
import { prepareProviderRequestOptions } from "../src/provider-request-options.mjs";
import { isNativeToolPermission } from "../src/permission-policy.mjs";

test("只补充可用的原生 PowerShell，保留显式工具集与平台边界", () => {
  let active = ["read_file", "run_command"], calls = 0;
  const pi = { getAllTools: () => [{ name: "powershell" }], getActiveTools: () => active, setActiveTools: tools => { active = tools; calls++; } };
  assert.equal(activateNativePowerShell(pi, "linux"), false); assert.equal(calls, 0);
  assert.equal(activateNativePowerShell(pi, "win32"), true); assert.deepEqual(active, ["read_file", "run_command", "powershell"]);
  activateNativePowerShell(pi, "win32"); assert.equal(calls, 1);
  active = ["read_file"]; assert.equal(activateNativePowerShell(pi, "win32"), false);
});
test("跨 shell 危险引用被识别，正确引用和普通 Bash 保持原样", () => {
  for (const command of ['powershell -NoProfile -Command "$s=1; $s"', 'pwsh -c "1 | ForEach-Object { $_ }"', String.raw`powershell -File D:\space\script.ps1`]) assert.equal(unsafePowerShellNesting(command), true, command);
  for (const command of ["echo $HOME", "powershell -Command '$s=1; $s'", 'powershell -EncodedCommand QQ==', String.raw`powershell -File "D:\space\script.ps1"`, 'powershell -Command "Write-Output 1"']) assert.equal(unsafePowerShellNesting(command), false, command);
});
test("PowerShell 默认期限为秒，显式期限不覆盖", () => {
  const hooks = {}; nativePowerShellContract({ on: (name, fn) => { hooks[name] = fn; } });
  const input = { command: "$x=1" }; hooks.tool_call({ toolName: "powershell", input });
  assert.equal(input.timeout, process.platform === "win32" ? 60 : undefined);
  const explicit = { command: "$x=1", timeout: 2 }; hooks.tool_call({ toolName: "powershell", input: explicit }); assert.equal(explicit.timeout, 2);
});

test("真实底座原生 PowerShell：变量、中文、路径、权限拒绝、错误与超时", { skip: process.platform !== "win32" || !process.env.STEP_TEST_CLI, timeout: 60000 }, async () => {
  const http = await httpFixture("openai-chat-completions"), f = await projectedClient("openai-chat-completions", http.baseUrl);
  f.client.options.env.STEPCODE_TASK_MODE = "desktop"; f.client.options.env.STEPCODE_STORAGE_ROOT_DIR = f.root + "/state";
  f.client.options.env.STEP_DISABLE_CRON = "1";
  f.client.options.command.push("--approval-mode", "confirm");
  let allow = true; const approvals = [];
  f.client.handleUiRequests(request => { approvals.push(request); return { confirmed: allow }; });
  try {
    await f.client.start(); await f.client.setModel(f.providerId, f.modelId);
    async function run(command, timeout) {
      await f.client.request({ type: "new_session" });
      await f.client.setModel(f.providerId, f.modelId);
      http.requests.length = 0;
      http.set({ kind: "tool", name: "powershell", args: { command, ...(timeout ? { timeout } : {}) }, text: "done" });
      await prepareProviderRequestOptions(f.client, { providerId: f.providerId, modelId: f.modelId, options: { reasoningLevel: "low" } });
      return f.client.promptAndWait("Only the result. Execute the requested command.", { timeoutMs: 18000 });
    }
    const script = String.raw`$value = '中文 $literal'; $path = 'D:\中文 空格\file.txt'; $sum = @(1,2 | ForEach-Object { $_ + 1 }); @{value=$value;path=$path;sum=$sum} | ConvertTo-Json -Compress`;
    let events = await run(script);
    const result = events.find(e => e.type === "tool_execution_end" && e.toolName === "powershell");
    assert.equal(result.isError, false, JSON.stringify(result)); const output = result.result.content.map(p => p.text ?? "").join("");
    assert.match(output, /中文 \$literal/); assert.match(output, /中文 空格/); assert.match(output, /2,3/);
    assert.ok(http.requests[0].body.tools.some(t => t.function.name === "powershell"));
    assert.ok(approvals.some(isNativeToolPermission), "原生权限确认必须生效");
    allow = false; const marker = f.root.replaceAll("\\", "/") + "/denied.txt";
    events = await run(`[IO.File]::WriteAllText('${marker}','must not run')`);
    assert.ok(events.some(e => e.type === "tool_execution_end" && e.isError)); await assert.rejects(readFile(marker), { code: "ENOENT" });
    allow = true; events = await run("throw '中文错误校验'");
    assert.ok(events.some(e => e.type === "tool_execution_end" && e.isError && JSON.stringify(e.result).includes("中文错误校验")));
    events = await run("Start-Sleep -Seconds 20", 1);
    assert.ok(events.some(e => e.type === "tool_execution_end" && e.isError && /timeout|timed out/i.test(JSON.stringify(e.result))));
    let aborted = false;
    const dispose = f.client.onEvent(event => {
      if (!aborted && event.type === "tool_execution_start" && event.toolName === "powershell") {
        aborted = true; setTimeout(() => { void f.client.abort(); }, 400);
      }
    });
    const started = Date.now(); events = await run("Start-Sleep -Seconds 30", 40); dispose();
    assert.equal(aborted, true); assert.ok(Date.now() - started < 12000);
    assert.ok(events.some(e => e.type === "agent_settled"));
  } finally { await f.client.stop(); await http.close(); }
});
