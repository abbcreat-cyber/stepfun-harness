import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeClarification,
  encodeQuestionnaire,
  clarificationResult,
  withDesktopQuestionnaire,
} from "../src/desktop-questionnaire.mjs";
import { createWorkflowBridge } from "../src/workflow/bridge.mjs";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { StepStreamProjection } from "../src/stream-projection.mjs";
import desktopQuestionnaire from "../src/extensions/desktop-questionnaire.mjs";

const input = {
  questions: [
    {
      id: "topic",
      question: "关注什么方向？",
      label: "方向",
      options: [
        { label: "芯片", value: "chips" },
        { label: "能源", value: "energy" },
      ],
      allow_freeform: false,
    },
    { id: "length", question: "简报多长？", label: "篇幅" },
  ],
};

test("same question text keeps distinct id answers through the UI renderer", async () => {
  const { register } = await import("tsx/esm/api");
  register();
  const { getAskUserQuestionAnswerText, normalizeAskUserQuestionInput } = await import(
    "../../ui/src/lib/askUserQuestion.ts"
  );
  const duplicateInput = { questions: [
    { id: "arrival", question: "日期？", label: "抵达" },
    { id: "departure", question: "日期？", label: "离开" },
  ] };
  const result = clarificationResult(normalizeClarification(duplicateInput), {
    action: "accept", content: { answer_0: "2026-10-08", answer_1: "2026-10-09" },
  });
  const answers = JSON.parse(result.content[0].text).answers;
  const questions = normalizeAskUserQuestionInput(duplicateInput).questions;
  assert.equal(getAskUserQuestionAnswerText(questions[0], answers, "missing"), "2026-10-08");
  assert.equal(getAskUserQuestionAnswerText(questions[1], answers, "missing"), "2026-10-09");
  assert.equal(getAskUserQuestionAnswerText(questions[0], { "日期？": "legacy" }, "missing"), "legacy");
  assert.equal(answers["日期？"], undefined);
});

test("rejected prompt preflight releases event wait without a later unhandled timeout", async () => {
  const client = new StepCodeRpcClient();
  client.prompt = async () => {
    throw new Error("fixture preflight refused");
  };
  await assert.rejects(
    client.promptAndWait("test", { timeoutMs: 20 }),
    /fixture preflight refused/,
  );
  assert.equal(client.eventListeners.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test("future native RPC answers and explicit cancellation never open a second questionnaire", async () => {
  let handler;
  desktopQuestionnaire({
    on(name, fn) {
      assert.equal(name, "tool_result");
      handler = fn;
    },
  });
  for (const text of ["User clarification cancelled", "question: Q\nanswer: A"]) {
    const value = await handler(
      { toolName: "clarify_user", content: [{ type: "text", text }] },
      {
        mode: "rpc",
        ui: {
          input() {
            assert.fail("must not ask again");
          },
        },
      },
    );
    assert.equal(value, undefined);
  }
  const rows = [],
    projection = new StepStreamProjection(rows, "t", "m");
  projection.handle({
    type: "tool_execution_start",
    toolCallId: "q",
    toolName: "clarify_user",
    args: input,
  });
  projection.handle({
    type: "tool_execution_end",
    toolCallId: "q",
    toolName: "clarify_user",
    isError: false,
    result: clarificationResult(normalizeClarification(input)),
  });
  assert.equal(rows.find((row) => row.toolCallId === "q").status, "cancelled");
});
function bridgeFixture() {
  const rows = [
    { kind: "toolCall", rowId: 5, toolCallId: "question-1" },
    { kind: "toolCall", rowId: 6, toolCallId: "unrelated" },
  ];
  return createWorkflowBridge({
    root: "unused",
    rows: () => rows,
    session: () => ({ mode: "yolo" }),
    changed() {},
    completed() {},
  });
}
test("structured questions stay pending even in yolo, anchor the correct row, and return exact values", async () => {
  const bridge = bridgeFixture();
  try {
    const waiting = bridge.permission("s", {
      method: "input",
      id: "ui-1",
      title: encodeQuestionnaire("question-1", input),
    });
    const pending = bridge.snapshot("s").pendingInteractions[0];
    assert.equal(pending.anchorRowId, 5);
    assert.equal(pending.payload.toolName, "AskUserQuestion");
    assert.equal(pending.payload.questions.length, 2);
    assert.equal(pending.payload.questions[0].allowFreeform, false);
    assert.throws(() =>
      bridge.resolve("other-session", pending.interactionId, { action: "cancel" }),
    );
    assert.throws(() =>
      bridge.resolve("s", pending.interactionId, {
        action: "accept",
        content: { answer_0: "invalid" },
      }),
    );
    assert.equal(bridge.snapshot("s").pendingInteractions.length, 1);
    const answer = { action: "accept", content: { answer_0: "chips", answer_1: "每天 500 字" } };
    bridge.resolve("s", pending.interactionId, answer);
    assert.deepEqual(JSON.parse((await waiting).value), answer);
    assert.equal(bridge.snapshot("s").pendingInteractions.length, 0);
    assert.throws(() => bridge.resolve("s", pending.interactionId, answer));
  } finally {
    await bridge.close();
  }
});
test("cancel, stop, abort and close release question waits", async () => {
  for (const action of ["cancel", "stop", "abort", "close"]) {
    const bridge = bridgeFixture(),
      controller = new AbortController();
    const waiting = bridge.permission(
      "s",
      { method: "input", id: "ui", title: encodeQuestionnaire("question-1", input) },
      controller.signal,
    );
    if (action === "cancel")
      bridge.resolve("s", bridge.snapshot("s").pendingInteractions[0].interactionId, {
        action: "cancel",
      });
    else if (action === "stop") bridge.cancelPending("s");
    else if (action === "abort") controller.abort();
    else await bridge.close();
    const reply = await waiting;
    assert.ok(reply.cancelled || JSON.parse(reply.value).action === "cancel");
    assert.equal(bridge.snapshot("s").pendingInteractions.length, 0);
    await bridge.close();
  }
});
test("answers preserve native ids/value and display labels without fabricating skipped answers", () => {
  const result = clarificationResult(normalizeClarification(input), {
    action: "accept",
    content: { answer_0: "chips" },
  });
  assert.deepEqual(JSON.parse(result.content[0].text).answers, { topic: "芯片", "关注什么方向？": "芯片" });
  assert.equal(result.details.answers[0].id, "topic");
  assert.equal(result.details.answers[0].value, "chips");
  assert.equal(result.details.answers.length, 1);
  assert.equal(result.details.cancelled, false);
  assert.equal(clarificationResult(normalizeClarification(input)).details.cancelled, true);
});
test("extension injection targets real Step commands once and keeps mocks unchanged", () => {
  const argv = ["D:/runtime/step.exe", "--mode", "rpc"];
  const enhanced = withDesktopQuestionnaire(argv);
  assert.ok(enhanced.includes("--extension"));
  assert.deepEqual(withDesktopQuestionnaire(enhanced), enhanced);
  assert.deepEqual(withDesktopQuestionnaire(["node", "mock.mjs"]), ["node", "mock.mjs"]);
});

test(
  "real Step RPC: native clarification blocks the model until desktop answers and final transcript receives them",
  { skip: !process.env.STEP_TEST_CLI, timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "question-rpc-"));
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    const requests = [],
      events = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "question-fixture",
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (requests.length === 1) {
        send({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "question-1",
              type: "function",
              function: { name: "clarify_user", arguments: JSON.stringify(input) },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({
          role: "assistant",
          content:
            "收到桌面答案：" +
            body.messages
              .filter((m) => m.role === "tool")
              .map((m) => m.content)
              .join(" "),
        });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const models = JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: "fixture-only",
          api: "openai-completions",
          models: [
            {
              id: "question-fixture",
              name: "Question fixture",
              reasoning: false,
              input: ["text", "image"],
              contextWindow: 32000,
              maxTokens: 2048,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    });
    await writeFile(join(root, "models.json"), models);
    const rows = [],
      projection = new StepStreamProjection(rows, "test", "question-fixture");
    const bridge = createWorkflowBridge({
      root,
      rows: () => rows,
      session: () => ({ mode: "yolo" }),
      changed() {},
      completed() {},
    });
    const client = new StepCodeRpcClient({
      command: [
        process.env.STEP_TEST_CLI,
        "--mode",
        "rpc",
        "--provider",
        "fixture",
        "--model",
        "question-fixture",
        "--no-session",
        "--approval-mode",
        "confirm",
      ],
      cwd: root,
      env: { STEP_CODING_AGENT_DIR: agent },
      onUiRequest: (request) => bridge.permission("s", request),
    });
    client.onEvent((event) => {
      events.push(event);
      projection.handle(event);
    });
    try {
      await client.start();
      const completed = client.promptAndWait("必须调用 clarify_user，等待用户选择方向和篇幅。", {
        timeoutMs: 45000,
      });
      completed.catch(() => {});
      for (let i = 0; i < 150 && !bridge.snapshot("s").pendingInteractions.length; i++)
        await new Promise((r) => setTimeout(r, 100));
      const pending = bridge.snapshot("s").pendingInteractions[0];
      assert.ok(pending, client.getStderr?.() || client.stderrText);
      assert.equal(requests.length, 1);
      assert.ok(!events.some((e) => e.type === "agent_settled"));
      assert.ok(!events.some((e) => e.type === "tool_execution_end"));
      bridge.resolve("s", pending.interactionId, {
        action: "accept",
        content: { answer_0: "chips", answer_1: "每天 500 字" },
      });
      await completed;
      assert.equal(requests.length, 2);
      assert.equal(events.find((e) => e.type === "tool_execution_end").isError, false);
      assert.match(await client.getLastAssistantText(), /chips/);
      assert.match(await client.getLastAssistantText(), /每天 500 字/);
      assert.equal(rows.find((row) => row.toolCallId === "question-1").toolName, "AskUserQuestion");
    } finally {
      await bridge.close();
      await client.stop();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);
