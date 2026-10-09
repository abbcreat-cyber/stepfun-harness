#!/usr/bin/env node
import { createInterface } from "node:readline";
import { officialPluginCallTimeout } from "../src/official-plugin-timeout.mjs";
import { readFile, mkdir, access } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { register } from "tsx/esm/api";
register(); // workspace public entrypoints contain TS-backed exports; reuse the established adapter loader.
const { createMcpAdapter } = await import("@zcode/adapters/mcp");
const { createNodeReplBrowserBroker } = await import("@zcode/bootstrap/node-repl-browser-broker");
const { createOfficialMcpTrustedOriginRegistry, resolveRuntimeZCodeEndpointOrigin } =
  await import("@zcode/shared");

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = resolve(option("--plugin-root")),
  serverName = option("--mcp-name");
const runtime = JSON.parse(await readFile(join(root, "step-official-runtime.json"), "utf8"));
const state = process.env.STEPCODE_STORAGE_ROOT_DIR;
const lifetime = new AbortController();
const requests = new Map();
const discovery = async (signal) => {
  let last;
  for (let attempt = 0; attempt < 100; attempt++)
    try {
      signal.throwIfAborted();
      return JSON.parse(
        await readFile(join(state, "browser-bridges", `${process.ppid}.json`), "utf8"),
      );
    } catch (error) {
      last = error;
      if (error.code !== "ENOENT") throw error;
      await delay(50, undefined, { signal });
    }
  throw new Error("插件所属底座尚未建立桌面连接", { cause: last });
};
async function relay(method, params = {}, signal = lifetime.signal) {
  signal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(90000)]);
  const connection = await discovery(signal);
  signal.throwIfAborted();
  const response = await fetch(connection.endpoint.replace(/\/execute$/, "/official-plugin"), {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "插件桌面连接失败");
  return result;
}
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
};
const browserBroker = createNodeReplBrowserBroker({
  logger,
  browserControlPort: {
    list: async (input) =>
      (
        await relay(
          "browserList",
          { sessionId: input.sessionId, turnId: input.turnId },
          input.signal,
        )
      ).browsers,
    execute: async (input) =>
      relay(
        "browserExecute",
        {
          sessionId: input.sessionId,
          turnId: input.turnId,
          browserId: input.browserId,
          browserGeneration: input.browserGeneration,
          command: input.command,
        },
        input.signal,
      ),
  },
});
await browserBroker.ready;
const origin = resolveRuntimeZCodeEndpointOrigin();
const toolEnvironment = { ...process.env };
try {
  await access(join(state, "plugins/computer-use/step.plugin.json"));
} catch {
  // Browser Use 启用不能隐式打开 Computer Use。原宿主只捕获当前已启用能力的 Helper 连接。
  for (const key of Object.keys(toolEnvironment))
    if (/^ZCODE_.*(?:CUA|HELPER)/.test(key)) delete toolEnvironment[key];
}
const adapterFor = (workingDirectory) =>
  createMcpAdapter({
    workingDirectory,
    logger,
    env: toolEnvironment,
    officialMcpAuth: {
      resolveZCodeApiOrigin: () => origin,
      trustedOrigins: createOfficialMcpTrustedOriginRegistry({
        resolveZCodeApiOrigin: () => origin,
      }),
      authHeadersPort: {
        resolveHeaders: (input) =>
          relay("authHeaders", { ...input, pluginId: `${runtime.plugin}@zcode-plugins-official` }),
      },
    },
  });
let mcp,
  ready,
  closed = false;
async function configuration(workingDirectory) {
  let userConfig = {};
  try {
    userConfig = JSON.parse(await readFile(join(root, "step-user-config.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const values = Object.fromEntries(
    Object.entries(runtime.userConfig ?? {}).map(([key, schema]) => [
      key,
      userConfig[key] ?? schema.default ?? "",
    ]),
  );
  const data = join(state, "plugin-data", runtime.plugin);
  await mkdir(data, { recursive: true });
  const expand = (value) =>
    typeof value === "string"
      ? value.replace(/\$\{([^}]+)\}/g, (_, key) =>
          key.startsWith("user_config.")
            ? String(values[key.slice(12)] ?? "")
            : ({
                ZCODE_PLUGIN_ROOT: root,
                CLAUDE_PLUGIN_ROOT: root,
                ZCODE_PLUGIN_DATA: data,
                CLAUDE_PLUGIN_DATA: data,
                ZCODE_PROJECT_DIR: workingDirectory,
                CLAUDE_PROJECT_DIR: workingDirectory,
                ZCODE_BASE_URL: origin,
              }[key] ??
              process.env[key] ??
              ""),
        )
      : value;
  const declared = runtime.servers[serverName];
  if (!declared) throw new Error("原版插件没有声明此 MCP");
  // Step 将 wrapper 锚定资产目录；用户工程目录必须取可信 Host 上下文，显式 cwd 则保留原声明。
  const cwd = resolve(workingDirectory, expand(declared.cwd ?? "."));
  if (declared._nodeRepl) {
    let host = join(state, "plugins/node-repl-host/dist/mcp/server.js");
    try {
      await access(host);
    } catch {
      host = join(state, "disabled-plugins/node-repl-host/dist/mcp/server.js");
    }
    return {
      type: "stdio",
      command: process.execPath,
      args: [host],
      cwd,
      protocolVersion: "2026-07-28",
      timeoutMs: 600000,
      env: {
        ZCODE_PLUGIN_ROOT: join(state, "plugins/browser-use"),
        ZCODE_CUA_PLUGIN_ROOT: join(state, "plugins/computer-use"),
        ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET: browserBroker.socketPath,
        ZCODE_NODE_REPL_BROWSER_BROKER_TOKEN: browserBroker.token,
      },
    };
  }
  const config = {
    ...declared,
    type: declared.type ?? (declared.url ? "http" : "stdio"),
    cwd,
    official: {
      source: "plugin",
      pluginId: `${runtime.plugin}@zcode-plugins-official`,
      mcpKey: serverName,
    },
  };
  if (config.type === "stdio") {
    const server = join(root, "dist/mcp/server.js");
    config.command = process.execPath;
    config.args = [server];
    config.env = Object.fromEntries(
      Object.entries(config.env ?? {}).map(([key, value]) => [key, expand(value)]),
    );
    config.env.ZCODE_PLUGIN_ROOT = root;
    config.env.ZCODE_PLUGIN_ID = `${runtime.plugin}@zcode-plugins-official`;
  } else {
    config.url = expand(config.url);
    config.headers = Object.fromEntries(
      Object.entries(config.headers ?? {}).map(([key, value]) => [key, expand(value)]),
    );
  }
  return config;
}
async function ensure() {
  if (!ready)
    ready = (async () => {
      const { workspacePath: workingDirectory } = await relay("context", {}, lifetime.signal);
      if (typeof workingDirectory !== "string" || !isAbsolute(workingDirectory))
        throw new Error("插件尚未绑定有效工作目录");
      const config = await configuration(workingDirectory);
      lifetime.signal.throwIfAborted();
      mcp = adapterFor(workingDirectory);
      const result = await mcp.connectConfiguredServers(
        { [serverName]: config },
        { workingDirectory, signal: lifetime.signal },
      );
      await relay("status", {
        pluginId: `${runtime.plugin}@zcode-plugins-official`,
        name: serverName,
        status: result.statuses[serverName],
      }).catch(() => {});
      if (result.statuses[serverName]?.status !== "connected")
        throw new Error(result.statuses[serverName]?.error || "原版插件 MCP 未能连接");
      return result;
    })();
  return ready;
}
async function call(frame, signal) {
  if (frame.method === "initialize")
    return {
      protocolVersion: frame.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: `stepcode-${runtime.plugin}-${serverName}`, version: "1.0.0" },
    };
  if (frame.method === "ping") return {};
  if (frame.method === "tools/list") {
    await ensure();
    return {
      tools: (await mcp.listTools()).map((tool) => ({
        name: tool.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    };
  }
  if (frame.method === "tools/call") {
    await ensure();
    signal.throwIfAborted();
    const context = await relay("context", {}, signal);
    signal.throwIfAborted();
    if (!context.sessionId) throw new Error("插件尚未绑定活动会话");
    return mcp.callTool(
      {
        serverName,
        toolName: frame.params.name,
        arguments: frame.params.arguments,
        trace: { traceId: randomUUID(), spanId: randomUUID(), sessionId: context.sessionId },
        runtimeScope: "main",
        workspacePath: context.workspacePath,
        workspaceKey: context.workspaceKey,
        clientMode: context.clientMode,
        turnId: context.turnId,
      },
      { timeoutMs: officialPluginCallTimeout(runtime.plugin, frame.params.name, frame.params.arguments), signal },
    );
  }
  throw new Error("不支持的 MCP 请求");
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (!frame || typeof frame !== "object" || closed) return;
  if (frame.id === undefined) {
    // Step Stop 通过 MCP 通知取消；不能将通知当作无效帧丢弃，也不能回复通知。
    if (frame.method === "notifications/cancelled") requests.get(frame.params?.requestId)?.abort();
    return;
  }
  const controller = new AbortController();
  // MCP 禁止取消 initialize；Map 保留 ID 原类型，避免数值与字符串 ID 串扰。
  if (frame.method !== "initialize") requests.set(frame.id, controller);
  void call(frame, controller.signal)
    .then((result) => {
      if (!controller.signal.aborted && !closed)
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
    })
    .catch((error) => {
      if (!controller.signal.aborted && !closed)
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32603, message: error.message },
          }) + "\n",
        );
    })
    .finally(() => {
      if (requests.get(frame.id) === controller) requests.delete(frame.id);
    });
});
async function close() {
  if (closed) return;
  closed = true;
  lifetime.abort();
  for (const controller of requests.values()) controller.abort();
  requests.clear();
  await ready?.catch(() => {});
  await Promise.allSettled([mcp?.close(), browserBroker.close()]);
}
lines.on("close", () => void close().finally(() => process.exit()));
process.on("SIGTERM", () => void close().finally(() => process.exit()));
process.on("SIGINT", () => void close().finally(() => process.exit()));
