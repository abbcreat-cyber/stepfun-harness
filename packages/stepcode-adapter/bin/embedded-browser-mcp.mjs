#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const directory = process.argv[process.argv.indexOf("--bridge-dir") + 1];
const string = { type: "string" };
const tabId = { type: "string", description: "只可使用 browser_tabs 或 browser_new_tab 返回的真实 tabId；首次导航请省略，不得编造。" };
const tools = [
  ["browser_navigate", "在软件右侧内置浏览器中打开 HTTP/HTTPS 网页或本机 file:/// HTML/HTM 页面（支持中文路径、相对资源），不启动外部浏览器。本地 HTML 直接导航，无需另起静态服务器；保留页面沙箱与跨源限制。", { url: string, tabId }, ["url"], "navigate"],
  ["browser_snapshot", "读取内置网页的可见内容和可点击 ref；交互前先读取。", { tabId }, [], "snapshot"],
  ["browser_click", "点击最新快照中的 ref，仅操作软件内置网页。", { ref: string, tabId }, ["ref"], "click"],
  ["browser_type", "向内置网页输入文本，可用 ref 指定输入框。", { ref: string, text: string, tabId }, ["text"], "type"],
  ["browser_press_key", "在内置网页按键，例如 Enter。", { key: string, ref: string, tabId }, ["key"], "press"],
  ["browser_evaluate", "在内置网页运行页面 JavaScript 表达式，读取 DOM 或网页状态。", { expression: string, tabId }, ["expression"], "evaluate"],
  ["browser_tabs", "列出当前会话在软件中的内置浏览器标签页。", {}, [], "list"],
  ["browser_new_tab", "在软件中创建新的内置浏览器标签页。", {}, [], "newTab"],
  ["browser_close", "关闭当前会话的内置浏览器标签页。", { tabId }, [], "close"],
  ["browser_screenshot", "截取内置网页画面，不移动用户鼠标。", { tabId }, [], "screenshot"],
];
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
async function callTool(name, args) {
  const tool = tools.find(item => item[0] === name);
  if (!tool) throw new Error("未知内置浏览器工具");
  const info = JSON.parse(await readFile(join(directory, `${process.ppid}.json`), "utf8"));
  const endpoint = new URL(info.endpoint);
  if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:") throw new Error("浏览器桥地址无效");
  const command = { method: tool[4] };
  for (const key of Object.keys(tool[2])) if (typeof args?.[key] === "string") command[key] = args[key];
  for (const key of tool[3]) if (!command[key]) throw new Error(`缺少参数 ${key}`);
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(120000) });
  const result = await response.json();
  if (!response.ok || !result.ok) return { isError: true, content: [{ type: "text", text: result.error?.message ?? "内置浏览器操作失败" }] };
  const { image, ...rest } = result;
  // 长快照的单行 JSON 会让 SDK 按行裁剪成 0 行；分行输出保留完整字段和动作 ref。
  const text = JSON.stringify(rest, null, tool[4] === "snapshot" ? 2 : undefined);
  return { content: [{ type: "text", text }, ...(image ? [{ type: "image", data: image.base64, mimeType: image.mimeType }] : [])] };
}
createInterface({ input: process.stdin }).on("line", async line => {
  let frame;
  try {
    frame = JSON.parse(line);
    if (frame.id === undefined) return;
    if (frame.method === "initialize") send(frame.id, { protocolVersion: frame.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stepcode-embedded-browser", version: "1.0.0" } });
    else if (frame.method === "ping") send(frame.id, {});
    else if (frame.method === "tools/list") send(frame.id, { tools: tools.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } })) });
    else if (frame.method === "tools/call") send(frame.id, await callTool(frame.params.name, frame.params.arguments));
    else process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Unknown method" } })}\n`);
  } catch (error) { if (frame?.id !== undefined) send(frame.id, { isError: true, content: [{ type: "text", text: error.message }] }); }
});
