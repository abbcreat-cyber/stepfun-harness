import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { register } from "tsx/esm/api";
import { officialPluginSource } from "../src/official-plugins.mjs";
register();
const { createMcpAdapter } = await import("@zcode/adapters/mcp");
const source = officialPluginSource();
const wrapper = fileURLToPath(new URL("../bin/official-plugin-mcp.mjs", import.meta.url));

async function fixture(t, kind, cwd) {
  const root = await mkdtemp(
    join(fileURLToPath(new URL("../../../", import.meta.url)), ".plugin-cwd-"),
  );
  const workspace = join(root, "workspace"),
    plugin = join(root, "plugins", kind);
  await mkdir(join(workspace, "nested"), { recursive: true });
  await mkdir(plugin, { recursive: true });
  let declaration;
  if (kind === "browser-use") {
    await cp(join(source, "node-repl-host"), join(root, "plugins/node-repl-host"), {
      recursive: true,
    });
    declaration = { _nodeRepl: true };
  } else if (kind === "android-emulator") {
    await cp(join(source, kind), plugin, { recursive: true });
    declaration = JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8")).mcpServers[kind];
    await mkdir(join(workspace, "app/src/main"), { recursive: true });
    await writeFile(
      join(workspace, "settings.gradle.kts"),
      'rootProject.name = "isolated-cwd"\ninclude(":app")',
    );
    await writeFile(join(workspace, "build.gradle.kts"), "");
    await writeFile(
      join(workspace, "app/build.gradle.kts"),
      'plugins { id("com.android.application") }\nandroid { namespace = "example.cwd"\n defaultConfig { applicationId = "example.cwd" } }',
    );
    await writeFile(
      join(workspace, "app/src/main/AndroidManifest.xml"),
      '<manifest package="example.cwd"/>',
    );
  } else {
    await mkdir(join(plugin, "dist/mcp"), { recursive: true });
    await writeFile(join(plugin, "package.json"), '{"type":"commonjs"}');
    await writeFile(
      join(plugin, "dist/mcp/server.js"),
      `
const {createInterface}=require('node:readline');
createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);let result;
 if(f.method==='initialize')result={protocolVersion:f.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'cwd-fixture',version:'1'}};
 if(f.method==='tools/list')result={tools:[{name:'cwd',inputSchema:{type:'object',properties:{}}}]};
 if(f.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),project:process.env.PROJECT,plugin:process.env.PLUGIN})}]};
 if(result)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result})+'\\n');
});
`,
    );
    declaration = {
      protocolVersion: "legacy",
      env: { PROJECT: "${ZCODE_PROJECT_DIR}", PLUGIN: "${ZCODE_PLUGIN_ROOT}" },
    };
  }
  if (cwd !== undefined) declaration.cwd = cwd;
  await writeFile(
    join(plugin, "step-official-runtime.json"),
    JSON.stringify({ plugin: kind, servers: { runtime: declaration } }),
  );
  // tools/list occurs before a session is attached; workspace alone must suffice for startup.
  let attached = false;
  const relay = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { method } = JSON.parse(body);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          method === "context"
            ? {
                workspacePath: workspace,
                workspaceKey: workspace,
                ...(attached ? { sessionId: "cwd-test", turnId: "t1" } : {}),
              }
            : { ok: true },
        ),
      );
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  await mkdir(join(root, "browser-bridges"), { recursive: true });
  await writeFile(
    join(root, "browser-bridges", `${process.pid}.json`),
    JSON.stringify({
      endpoint: `http://127.0.0.1:${relay.address().port}/execute`,
      token: "cwd-fixture",
    }),
  );
  const client = createMcpAdapter();
  t.after(async () => {
    await client.close();
    relay.closeAllConnections();
    await new Promise((r) => relay.close(r));
    // Windows 在子进程退出后可能短暂保留 cwd 句柄；只对清理的 EBUSY 做有界重试。
    await rm(root, { recursive: true, force: true, maxRetries:5, retryDelay:100 });
  });
  const connection = await client.connectConfiguredServers({
    wrapper: {
      type: "stdio",
      command: process.execPath,
      args: [wrapper, "--plugin-root", plugin, "--mcp-name", "runtime"],
      cwd: plugin,
      protocolVersion: "legacy",
      env: { STEPCODE_STORAGE_ROOT_DIR: root },
    },
  });
  assert.equal(
    connection.statuses.wrapper.status,
    "connected",
    JSON.stringify(connection.statuses),
  );
  assert.ok((await client.listTools()).length > 0);
  attached = true;
  return {
    workspace,
    plugin,
    call: (toolName, args = {}) =>
      client.callTool({ serverName: "wrapper", toolName, arguments: args }),
  };
}

test(
  "original Node Repl starts in trusted workspace without an active session",
  {
    timeout: 20000,
    skip: !existsSync(join(source, "node-repl-host/dist/mcp/server.js")),
  },
  async (t) => {
    const h = await fixture(t, "browser-use");
    const result = await h.call("js", {
      title: "只读工作目录验证",
      code: "nodeRepl.write((await import('node:process')).cwd())",
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(
      result.content.some((c) => c.text?.includes(h.workspace)),
      JSON.stringify(result),
    );
  },
);

test(
  "stdio declaration preserves expanded and relative cwd while project variable stays workspace",
  { timeout: 20000 },
  async (t) => {
    for (const cwd of ["${ZCODE_PROJECT_DIR}/nested", "nested", "${ZCODE_PLUGIN_ROOT}"]) {
      await t.test(cwd, async (t) => {
        const h = await fixture(t, "fixture", cwd);
        const result = await h.call("cwd");
        const actual = JSON.parse(result.content[0].text);
        assert.equal(actual.project, h.workspace);
        assert.equal(actual.plugin, h.plugin);
        assert.equal(
          actual.cwd,
          cwd === "${ZCODE_PLUGIN_ROOT}" ? h.plugin : resolve(h.workspace, "nested"),
        );
      });
    }
  },
);

test(
  "original Android runtime discovers the isolated workspace Gradle project",
  {
    timeout: 20000,
    skip: !existsSync(join(source, "android-emulator/dist/mcp/server.js")),
  },
  async (t) => {
    const h = await fixture(t, "android-emulator");
    const result = await h.call("android_discover_project");
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    assert.match(text, /example\.cwd/);
    assert.match(text, /app/);
  },
);
