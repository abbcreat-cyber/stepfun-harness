import { createServer } from "node:http";
import { textEvents, protocols } from "./provider-wire-fixtures.mjs";

/** 只为自动轮时序验收提供本机 SSE；每次 set 有唯一 toolCallId，避免与历史工具回执混淆。 */
export async function automationHttpFixture() {
  const requests = [];
  let action = { kind: "text", text: "fixture" },
    sequence = null,
    id = 0,
    sentTool = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ body });
    const current = sequence ? sequence.shift() : action;
    if (!current) {
      response.writeHead(500).end("unexpected extra request");
      return;
    }
    let events;
    if (current.kind === "tool" && (sequence || !sentTool)) {
      sentTool = true;
      events = [
        {
          choices: [
            {
              index: 0,
              delta: {
                content: "我先执行本地自动化测试操作，再核对回执。",
                tool_calls: [
                  {
                    index: 0,
                    id: `automation_call_${++id}`,
                    type: "function",
                    function: { name: current.name, arguments: JSON.stringify(current.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ];
    } else events = textEvents(protocols[0], current.text ?? "fixture");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events
        .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
        .join(""),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    set(next) {
      action = next;
      sequence = null;
      sentTool = false;
    },
    setSequence(next) {
      sequence = [...next];
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
