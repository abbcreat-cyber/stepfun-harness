import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { readWorkflowGuide } from "../src/workflow/guide.mjs";

test("MCP guide preserves Markdown lines so Step can read language rules and continue the full guide", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-guide-wire-"));
  const guide = await readWorkflowGuide();
  const server = createServer(async (request, response) => {
    let input = "";
    for await (const part of request) input += part;
    const call = JSON.parse(input);
    assert.equal(request.headers.authorization, "Bearer local-test");
    const result =
      call.method === "ReadWorkflowGuide"
        ? call.params.section === "missing"
          ? { ok: false, message: "未知章节" }
          : guide
        : { ok: true, runs: [] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let child;
  try {
    await writeFile(
      join(root, `${process.pid}.json`),
      JSON.stringify({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        token: "local-test",
      }),
    );
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/workflow-mcp.mjs", import.meta.url)), "--bridge-dir", root],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const frames = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let id = 0;
    const call = async (method, params = {}) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`);
      const next = await frames.next();
      assert.equal(next.done, false);
      const frame = JSON.parse(next.value);
      assert.equal(frame.id, id);
      return frame.result;
    };
    const registered = (await call("tools/list")).tools.map(tool => tool.name);
    for (const name of ["EvalWorkflowSnippet", "AmendWorkflow", "ResolveWorkflowQuestion"]) {
      assert.ok(registered.includes(name), `${name} must be callable through MCP`);
      assert.equal((await call("tools/call", { name, arguments: {} })).isError, false);
    }
    const result = await call("tools/call", {
      name: "ReadWorkflowGuide",
      arguments: { section: "skill" },
    });
    assert.equal(result.isError, false);
    const text = result.content[0].text;
    assert.ok(text.endsWith(guide.content), "MCP 模型可见文本必须逐字包含原版正文，不能转义换行");
    assert.match(text, /Full output.*read_file/);
    assert.match(text, /按当前工具声明用 start_line\/end_line/);
    assert.match(text, /读完/);
    // Step 的真实边界按完整行保留前 50KB；旧的一行 JSON 会保留零行。
    let bytes = 0;
    const kept = [];
    for (const line of text.split("\n")) {
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > 50 * 1024) break;
      kept.push(line);
    }
    assert.match(kept.join("\n"), /## 9\. Write for the user/);
    assert.match(kept.join("\n"), /Subagent name \| Code reviewer \/ 代码评审员/);
    const normal = await call("tools/call", { name: "ListWorkflowRuns" });
    assert.deepEqual(JSON.parse(normal.content[0].text), { ok: true, runs: [] });
    const error = await call("tools/call", {
      name: "ReadWorkflowGuide",
      arguments: { section: "missing" },
    });
    assert.equal(error.isError, true);
    assert.deepEqual(JSON.parse(error.content[0].text), { ok: false, message: "未知章节" });
  } finally {
    if (child && child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
