import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { recordPluginRuntimeStatus } from "./plugin-runtime-status.mjs";
import { createDesktopAutomationPort } from "./desktop-automation-port.mjs";

/** Host 使用 strict schema；内部自动化/权限上下文不能混入浏览器参数。 */
export function browserInteractionContext(context) {
  const keys = ["sessionId", "turnId", "workspaceKey", "workspacePath", "workspaceIdentity", "remoteSessionId", "clientMode", "sessionContext"];
  return Object.fromEntries(keys.filter(key => context[key] !== undefined).map(key => [key, context[key]]));
}

/** 将 Step 的 MCP 请求送回当前 Host 的既有浏览器执行器，保留会话与代次隔离。 */
export async function startEmbeddedBrowserRelay({
  directory,
  requestHost,
  getContext,
  workflowRequest,
  pluginStatuses = new Map(),
}) {
  const tokens = new Map(),
    files = new Set();
  const automationRequest = createDesktopAutomationPort(requestHost);
  const allowed = new Set([
    "navigate",
    "snapshot",
    "getState",
    "click",
    "type",
    "press",
    "evaluate",
    "list",
    "newTab",
    "close",
    "screenshot",
  ]);
  const server = createServer(async (request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    const pid = tokens.get(token);
    const context = pid ? getContext(pid) : null;
    if (
      request.method !== "POST" ||
      !["/execute", "/workflow", "/official-plugin", "/desktop-automation"].includes(request.url) ||
      !context
    ) {
      response.writeHead(403).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 262144) throw new Error("浏览器请求过大");
      }
      const command = JSON.parse(body);
      if (request.url === "/desktop-automation") {
        const live = () => {
          const current = tokens.get(token) === pid ? getContext(pid) : null;
          if (request.aborted || response.destroyed || current?.desktopTaskMode !== true || !current.activeTurn ||
              !current.sessionId || !current.turnId ||
              (command.method !== "context" && (command.sessionId !== current.sessionId || command.turnId !== current.turnId)))
            throw new Error("Desktop automation request is stale or unavailable");
          return current;
        };
        const result = command.method === "context"
          ? (({ sessionId, turnId }) => ({ sessionId, turnId }))(live())
          : await automationRequest(command, live);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      if (request.url === "/official-plugin") {
        let result;
        if (command.method === "context") result = context;
        else if (command.method === "status") {
          pluginStatuses.set(
            `${command.params.pluginId}:${command.params.name}`,
            command.params.status,
          );
          await recordPluginRuntimeStatus(
            join(directory, ".."),
            pid,
            command.params.pluginId,
            command.params.name,
            command.params.status,
          );
          result = { ok: true };
        } else if (command.method === "authHeaders")
          result = await requestHost("interaction/requestOfficialMcpAuthHeaders", {
            workspace: { workspacePath: context.workspacePath, workspaceKey: context.workspaceKey },
            pluginId: command.params.pluginId,
            mcpKey: command.params.mcpKey,
            targetOrigin: command.params.targetOrigin,
          });
        else if (command.method === "browserList" || command.method === "browserExecute") {
          await access(join(directory, "../plugins/browser-use/step.plugin.json")).catch(() => {
            throw new Error("原版浏览器插件已停用");
          });
          // body/文件读取可跨越 Stop 与下一轮启动；派发前重查唯一会话所有者，禁止旧请求换上新 turnId。
          const liveContext = tokens.get(token) === pid ? getContext(pid) : null;
          if (
            request.aborted ||
            response.destroyed ||
            !liveContext?.sessionId ||
            command.params.sessionId !== liveContext.sessionId ||
            command.params.turnId !== liveContext.turnId
          )
            throw new Error("浏览器请求已失效或不属于当前轮次");
          result = await requestHost(
            command.method === "browserList"
              ? "interaction/browserList"
              : "interaction/browserExecute",
            {
              ...browserInteractionContext(liveContext),
              turnId: command.params.turnId,
              ...(command.method === "browserExecute"
                ? {
                    browserId: command.params.browserId,
                    browserGeneration: command.params.browserGeneration,
                    command: command.params.command,
                  }
                : {}),
            },
          );
        } else throw new Error("不支持的原版插件请求");
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      if (request.url === "/workflow") {
        if (!workflowRequest) throw new Error("工作流尚未就绪");
        const controller = new AbortController();
        const disconnected = () => { if (!response.writableEnded) controller.abort("disconnected"); };
        response.once("close", disconnected);
        try {
          if (response.destroyed) controller.abort("disconnected");
          const result = await workflowRequest(command, { ...context, signal: controller.signal });
          if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } finally { response.removeListener("close", disconnected); }
        return;
      }
      if (!allowed.has(command.method)) throw new Error("不支持的内置浏览器操作");
      const discovery = await requestHost("interaction/browserList", browserInteractionContext(context));
      const backend = discovery.browsers?.find((browser) => browser.type === "iab");
      if (!backend) throw new Error("当前软件的内置浏览器尚未就绪");
      const result = await requestHost("interaction/browserExecute", {
        ...browserInteractionContext(context),
        browserId: backend.id,
        browserGeneration: backend.generation,
        command,
      });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: false, error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/execute`;
  return {
    async bindPid(pid) {
      // 一个桥接只拥有一个当前 Step 进程；换进程立即撤销旧令牌，防止 PID 重用。
      tokens.clear();
      const token = randomBytes(32).toString("hex");
      tokens.set(token, pid);
      await mkdir(directory, { recursive: true });
      const file = join(directory, `${pid}.json`);
      await writeFile(file, JSON.stringify({ endpoint, token }), { mode: 0o600 });
      files.add(file);
    },
    async close() {
      tokens.clear();
      server.closeAllConnections();
      server.close();
      await Promise.all([...files].map((file) => unlink(file).catch(() => {})));
    },
  };
}
