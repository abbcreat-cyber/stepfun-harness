import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { StepStreamProjection } from "../src/stream-projection.mjs";
import { projectedClient, textEvents } from "./provider-wire-fixtures.mjs";

async function nativeCommandCases(t, cases) {
  let action, issued = false;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (value) => res.write(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
    if (!issued && action) {
      issued = true;
      send({ id: "deadline", choices: [{ index: 0, delta: { role: "assistant", content: "我先验证隔离命令的超时和取消。", tool_calls: action.map((args, index) => ({
        index, id: `command_${index}`, type: "function", function: { name: "run_command", arguments: JSON.stringify(args) },
      })) }, finish_reason: null }] });
      send({ id: "deadline", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      send("[DONE]");
    } else {
      for (const event of textEvents("openai-chat-completions", "LOCAL_NEXT_TURN_OK")) send(event);
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const f = await projectedClient("openai-chat-completions", `http://127.0.0.1:${server.address().port}/v1`);
  const script = join(f.root, "deadline-tree.mjs");
  const marker = join(f.root, "deadline-pids.json");
  const grepMarker = `R50_PIPE_NEVER_MATCH_${f.root.split(/[\\/]/).at(-1)}`;
  const execute = promisify(execFile);
  async function pipelinePids() {
    if (process.platform !== "win32") return [];
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'grep.exe' -and $_.CommandLine -like '*${grepMarker}*' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`], { windowsHide: true });
    const value = stdout.trim() ? JSON.parse(stdout) : [];
    return Array.isArray(value) ? value : [value];
  }
  await writeFile(script, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});
writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);
`);
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}" "${marker.replaceAll("\\", "/")}"`;
  const client = new StepCodeRpcClient({
    command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions", "--extension",
      fileURLToPath(new URL("../src/extensions/desktop-task-contracts.mjs", import.meta.url))],
    env: { ...f.env, STEPCODE_TASK_MODE: "desktop", STEP_DISABLE_CRON: "1" },
    cwd: f.root,
    onUiRequest: () => ({ confirmed: true }),
  });
  t.after(async () => {
    await client.stop();
    for (const pid of await pipelinePids()) {
      try { process.kill(pid); } catch {}
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await client.start();
  await client.setModel(f.providerId, f.modelId);
  const evidence = [];
  for (const kind of cases) {
    await rm(marker, { force: true });
    issued = false;
    action = [
      { command: kind.startsWith("pipeline") ? `echo PIPELINE_START; ${command} | grep -l ${grepMarker} | head -20; echo PIPELINE_END` : command,
        ...(["explicit", "pipeline"].includes(kind) ? { timeout_ms: 1000 } : {}) },
      { command: "echo DEADLINE_SIBLING_OK" },
    ];
    const rows = [];
    const projection = new StepStreamProjection(rows, "native-deadline", f.modelId);
    const unsubscribe = client.onEvent(event => projection.handle(event));
    const start = Date.now();
    const settled = client.promptAndWait(`ISOLATED_DEADLINE_${kind}`, { timeoutMs: 75000 });
    settled.catch(() => {});
    if (kind.endsWith("cancel")) {
      for (let i = 0; i < 100; i++) {
        try { await readFile(marker); break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await client.abort();
    }
    const events = await settled;
    unsubscribe();
    const elapsedMs = Date.now() - start;
    const ends = events.filter(event => event.type === "tool_execution_end");
    assert.equal(ends.length, 2, `${kind}: both native tools must finish`);
    assert.ok(ends.some(event => event.isError), `${kind}: actual timeout/abort must be an error`);
    assert.ok(events.some(event => event.type === "agent_settled"));
    assert.equal(rows.filter(row => row.kind === "toolCall" && ["running", "inputStreaming"].includes(row.status)).length, 0);
    if (kind === "default") assert.ok(elapsedMs >= 59000 && elapsedMs < 72000, `default deadline: ${elapsedMs}`);
    if (kind === "explicit") assert.ok(elapsedMs < 6000, `explicit deadline changed: ${elapsedMs}`);
    const pids = JSON.parse(await readFile(marker, "utf8"));
    if (kind.startsWith("pipeline")) assert.deepEqual(await pipelinePids(), [], "Git Bash pipeline grep must not survive native timeout or cancel");
    for (const pid of pids) {
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
      assert.equal(alive, false, `${kind}: leaked shell descendant ${pid}`);
    }
    action = undefined;
    const next = await client.promptAndWait(`ISOLATED_NEXT_TURN_${kind}`);
    assert.ok(next.some(event => event.type === "message_end" && JSON.stringify(event.message).includes("LOCAL_NEXT_TURN_OK")));
    evidence.push({ kind, elapsedMs, endedTools: ends.length, descendantPidsGone: pids.length, nextTurn: true });
  }
  assert.ok(requests.every(request => request.model === f.modelId));
  if (process.env.STEP_WIRE_EVIDENCE_DIR) await writeFile(join(process.env.STEP_WIRE_EVIDENCE_DIR, `command-deadline-native-${cases.join("-")}.json`), JSON.stringify({ pass: true, evidence, localRequests: requests.length }, null, 2));
}

const options = { skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for native command execution", timeout: 100000 };
test("real SDK default deadline finishes sibling rows and accepts next turn", options, t => nativeCommandCases(t, ["default"]));
test("real SDK explicit/pipeline/cancel kills shell descendants and accepts next turn", options, t => nativeCommandCases(t, ["explicit", "pipeline", "pipeline-cancel", "cancel"]));
