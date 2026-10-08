import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectionFixture } from "./provider-projection-client.mjs";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";

export const protocols = ["openai-chat-completions", "openai-responses", "anthropic-messages"];
export const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=";
export const markerText = "WIRE_READ_ONLY_MARKER_测";
const chat = (delta = {}, finish = null) => ({
  id: "wire",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

// 标准协议事件夹具；不实现或替换原生 HTTP/SSE 消费器。
export function textEvents(protocol, text) {
  if (protocol === protocols[0])
    return [
      chat({ role: "assistant", content: "" }),
      chat({ content: text }),
      chat({}, "stop"),
      {
        id: "wire",
        choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      },
      "[DONE]",
    ];
  if (protocol === protocols[1])
    return [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_wire", role: "assistant", content: [] },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_wire",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "wire",
          status: "completed",
          output: [],
          usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
        },
      },
    ];
  return [
    {
      type: "message_start",
      message: {
        id: "wire",
        model: "wire",
        type: "message",
        role: "assistant",
        content: [],
        usage: { input_tokens: 9, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

function toolEvents(protocol, name, args, rawArguments, initialObject = false) {
  const argumentsJson = rawArguments ?? JSON.stringify(args),
    id = "call_wire";
  if (protocol === protocols[0])
    return [
      chat({ role: "assistant", content: "我先执行本地测试所需的操作，再核对结果。" }),
      chat({
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: { name, arguments: argumentsJson.slice(0, 9) },
          },
        ],
      }),
      chat({ tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(9) } }] }),
      chat({}, "tool_calls"),
      "[DONE]",
    ];
  if (protocol === protocols[1])
    return [
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "opening", role: "assistant", content: [] } },
      { type: "response.content_part.added", output_index: 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "我先执行本地测试所需的操作，再核对结果。" },
      { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "opening", role: "assistant", content: [{ type: "output_text", text: "我先执行本地测试所需的操作，再核对结果。", annotations: [] }] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id, call_id: id, name, arguments: "" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: argumentsJson },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id, call_id: id, name, arguments: argumentsJson },
      },
      {
        type: "response.completed",
        response: {
          id: "wire",
          status: "completed",
          output: [],
          usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
        },
      },
    ];
  return [
    textEvents(protocol, "")[0],
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "我先执行本地测试所需的操作，再核对结果。" } },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: initialObject ? args : {} },
    },
    ...(initialObject
      ? []
      : [
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: argumentsJson },
          },
        ]),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

async function sse(res, protocol, events, newline = "\r\n", slow = false) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const wire = events
    .map(
      (event) =>
        `${protocol === protocols[2] ? `event: ${event.type}${newline}` : ""}data: ${typeof event === "string" ? event : JSON.stringify(event)}${newline}${newline}`,
    )
    .join("");
  const bytes = Buffer.from(wire);
  let sentBytes = 0;
  // 小块写入与异步调度使 CR/LF 和 Unicode 的网络 chunk 边界独立于 JSON 事件。
  for (let offset = 0; offset < bytes.length && !res.destroyed; offset += 7) {
    res.write(bytes.subarray(offset, offset + 7));
    sentBytes = Math.min(offset + 7, bytes.length);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!slow && !res.destroyed) res.end();
  return bytes.subarray(0, sentBytes).toString();
}

export async function httpFixture(protocol) {
  const requests = [],
    toolFrames = [],
    errors = [],
    closed = [];
  let action = { kind: "text", text: "WIRE_TEXT_测🙂", newline: "\r\n" };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const captured = {
        action: action.kind,
        path: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      };
      requests.push(captured);
      res.once("close", () => closed.push(captured));
      if (
        action.strict &&
        ["store", "stream_options", "max_completion_tokens"].some((key) => key in captured.body)
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "strict fixture rejects store/usage/max_completion_tokens" },
          }),
        );
        return;
      }
      if (action.kind === "http-error") {
        res.writeHead(action.status, { "content-type": "application/json", "retry-after": "0" });
        res.end(
          JSON.stringify({
            error: { type: "fixture_error", message: `WIRE_HTTP_${action.status}` },
          }),
        );
        return;
      }
      if (action.kind === "stream-error") {
        const error = { message: "WIRE_STREAM_ERROR", type: "invalid_request_error" };
        const events =
          protocol === protocols[0]
            ? [{ error }]
            : protocol === protocols[1]
              ? [{ type: "error", code: "fixture_error", message: error.message }]
              : [{ type: "error", error }];
        await sse(res, protocol, events);
        return;
      }
      if (
        action.kind === "tool" &&
        !requests.some((entry) => entry.action === "tool" && hasToolResult(protocol, entry.body))
      ) {
        const events = toolEvents(
          protocol,
          action.name,
          action.args,
          action.rawArguments,
          action.initialObject,
        );
        const raw = await sse(res, protocol, events, action.newline);
        toolFrames.push({ events, raw });
        return;
      }
      const events = textEvents(protocol, action.text);
      await sse(
        res,
        protocol,
        action.kind === "slow" ? events.slice(0, protocol === protocols[0] ? 2 : 3) : events,
        action.newline,
        action.kind === "slow",
      );
    } catch (error) {
      errors.push(error.message);
      if (!res.destroyed) {
        res.writeHead(500);
        res.end("fixture failure");
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    toolFrames,
    errors,
    closed,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    set(next) {
      action = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function hasToolResult(protocol, body) {
  if (protocol === protocols[0])
    return body.messages.some(
      (message) => message.role === "tool" && message.tool_call_id === "call_wire",
    );
  if (protocol === protocols[1])
    return body.input.some(
      (item) => item.type === "function_call_output" && item.call_id === "call_wire",
    );
  return body.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (item) => item.type === "tool_result" && item.tool_use_id === "call_wire",
      ),
  );
}

export function readTool(body, marker) {
  const tools = body.tools.map((tool) => tool.function ?? tool);
  const tool = tools.find((candidate) => ["read_file", "read"].includes(candidate.name));
  if (!tool)
    throw new Error(
      `No native read tool; observed ${tools.map((candidate) => candidate.name).join(",")}`,
    );
  const schema = tool.parameters ?? tool.input_schema;
  const field = ["file_path", "path", "absolute_path"].find((key) => key in schema.properties);
  if (!field) throw new Error(`Unsupported native read schema ${JSON.stringify(schema)}`);
  return { name: tool.name, args: { [field]: marker } };
}

export function assistant(events) {
  return events.findLast(
    (event) => event.type === "message_end" && event.message?.role === "assistant",
  )?.message;
}
export function messageText(message) {
  return (
    message?.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? ""
  );
}

export async function projectedClient(protocol, baseUrl, extra = {}) {
  const rootBase = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-wire-tests";
  await mkdir(rootBase, { recursive: true });
  const root = await mkdtemp(join(rootBase, "wire-")),
    marker = join(root, "marker.txt");
  await mkdir(join(root, "agent"));
  await writeFile(marker, markerText);
  const providerId = `wire-unlisted-${protocol}`,
    modelId = "unlisted-model-20261008";
  const native = {
    reasoning: true,
    headers: { "X-Wire-Model": "model", "X-Wire-Priority": "model" },
    thinkingLevelMap: { high: "high" },
    ...extra.native,
  };
  const config = {
    properties: { contextWindow: 24576, inputFormat: { supportsImage: true } },
    optionSpecs: { maxOutputTokens: { max: 2048 }, ...extra.optionSpecs },
    native,
  };
  const view = {
    providerId,
    config: {
      access: { type: "api-key", apiKey: "sk-fixture-wire-only", ...extra.access },
      api: {
        type: protocol,
        baseUrl,
        headers: { "X-Wire-Provider": "provider", "X-Wire-Priority": "provider" },
        ...extra.api,
      },
    },
    models: [{ modelId, config }],
  };
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/API_KEY|TOKEN|SECRET|PROXY|^(STEP_|STEPCODE_)/i.test(key)) delete env[key];
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    STEP_CODING_AGENT_DIR: join(root, "agent"),
    STEP_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    NO_PROXY: "127.0.0.1,localhost",
  });
  const projected = await projectionFixture({ views: [view], env });
  const document = projected.document;
  const approvals = [];
  const client = new StepCodeRpcClient({
    command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-session", "--no-extensions"],
    cwd: root,
    env,
    requestTimeoutMs: 15000,
    onUiRequest(request) {
      approvals.push(request);
      const serialized = JSON.stringify(request).replaceAll("\\\\", "/").replaceAll("\\", "/");
      return {
        confirmed:
          serialized.includes(marker.replaceAll("\\", "/")) && /read|读取/i.test(serialized),
      };
    },
  });
  return {
    client,
    root,
    marker,
    providerId,
    modelId,
    document,
    approvals,
    env,
    registryView: projected.views[0],
  };
}
