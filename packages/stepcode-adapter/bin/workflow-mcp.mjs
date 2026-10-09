#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const directory = process.argv[process.argv.indexOf("--bridge-dir") + 1];
const string = { type: "string" };
const tools = [
  [
    "ReadWorkflowGuide",
    "首次创建前读取原 ZCode 完整工作流技能。已读过可复用；patterns 返回原版拓扑、并行 join 与阶段标记章节。",
    { section: { type: "string", enum: ["skill", "patterns", "examples", "reference"] } },
    [],
  ],
  [
    "CreateWorkflow",
    "编译动态工作流，展示现有确认框，用户允许后在后台运行；StepCode 执行子任务。拒绝时绝不运行。",
    {
      script: string,
      script_path: string,
      path: string,
      name: string,
      max_concurrency: { type: "integer", minimum: 1, maximum: 8 },
      subagent_model: string,
      saved: {
        type: "object",
        properties: { name: string, args: { type: "object" } },
        required: ["name"],
      },
    },
    [],
  ],
  ["GetWorkflowRun", "读取当前会话工作流的真实状态、节点与结果。", { runId: string }, ["runId"]],
  ["ListWorkflowRuns", "列出当前会话的工作流与状态。", {}, []],
  ["EvalWorkflowSnippet", "用原版沙箱同步验证 TypeScript 片段，不创建持久运行；world.run 命令先确认。", { code: string, path: string, timeoutMs: { type: "integer", minimum: 1, maximum: 600000 } }, []],
  ["AmendWorkflow", "修订工作流，保留原引擎缓存与会话前缀；编译失败不会停止前驱。仅改并发可原地调整。", { run_id: string, script: string, path: string, name: string, max_concurrency: { type: ["integer", "null"], minimum: 1, maximum: 8 }, subagent_model: { type: ["string", "null"] } }, ["run_id"]],
  ["ResolveWorkflowQuestion", "回答正在执行的工作流子代理提出的阻塞问题，question_id 见通知或 GetWorkflowRun。", { question_id: string, answer: string }, ["question_id", "answer"]],
  ["CancelWorkflowRun", "停止当前会话的一次工作流运行。", { runId: string }, ["runId"]],
  [
    "ResumeWorkflowRun",
    "恢复已停止的工作流，重新确认后重放完成节点并继续未完成任务。",
    { runId: string },
    ["runId"],
  ],
  [
    "SaveWorkflow",
    "保存可复用的工作流脚本；同名已存在时拒绝覆盖。",
    {
      name: string,
      description: string,
      script: string,
      script_path: string,
      scope: { type: "string", enum: ["project", "global"] },
    },
    ["name"],
  ],
  [
    "ListSavedWorkflows",
    "列出本项目或全局保存的工作流。",
    { scope: { type: "string", enum: ["project", "global"] } },
    [],
  ],
];
const send = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
async function connection() {
  try {
    return JSON.parse(await readFile(join(directory, `${process.ppid}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
    if (frame.id === undefined) return;
    if (frame.method === "initialize")
      return send(frame.id, {
        protocolVersion: frame.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "step-workflows", version: "1.0.0" },
      });
    if (frame.method === "ping") return send(frame.id, {});
    const info = await connection();
    if (frame.method === "tools/list")
      return send(frame.id, {
        tools: info
          ? tools.map(([name, description, properties, required]) => ({
              name,
              description,
              inputSchema: { type: "object", properties, required, additionalProperties: false },
            }))
          : [],
      });
    if (frame.method !== "tools/call") throw new Error("未知工作流协议方法");
    if (!info) throw new Error("工作流只能由 Step Code 桌面主会话调用");
    if (!tools.some((tool) => tool[0] === frame.params.name)) throw new Error("未知工作流工具");
    const endpoint = new URL(info.endpoint);
    if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:")
      throw new Error("工作流桥地址无效");
    endpoint.pathname = "/workflow";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
      body: JSON.stringify({ method: frame.params.name, params: frame.params.arguments ?? {} }),
      signal: AbortSignal.timeout(3600000),
    });
    const result = await response.json();
    // 原版全文超过 Step 的 50KB 预算；一行 JSON 会被截成零行，连语言规则都读不到。
    // 保留 Markdown 换行和原文，超预算时沿用底座原有文件续读机制。
    const text =
      frame.params.name === "ReadWorkflowGuide" &&
      typeof result.content === "string" &&
      response.ok &&
      result.ok !== false
        ? `版本：${result.version}\n接入说明：${result.integration}\n\n完整指南较长；若底座提示截断，请用 Full output 给出的实际路径调用 read_file，按当前工具声明用 start_line/end_line 从下一行续读直到读完，不使用未声明的 offset/limit 参数，再编写脚本。以下为原 ZCode 技能原文：\n\n${result.content}`
        : JSON.stringify(result);
    send(frame.id, {
      isError: !response.ok || result.ok === false,
      content: [{ type: "text", text }],
    });
  } catch (error) {
    if (frame?.id !== undefined)
      send(frame.id, { isError: true, content: [{ type: "text", text: error.message }] });
  }
});
