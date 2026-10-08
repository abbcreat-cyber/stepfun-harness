import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  protocols,
  imageData,
  markerText,
  httpFixture,
  projectedClient,
  assistant,
  messageText,
  readTool,
  hasToolResult,
} from "./provider-wire-fixtures.mjs";

const installedCli = process.env.STEP_TEST_CLI;
const options = {
  skip:
    !installedCli &&
    "Set STEP_TEST_CLI to the installed Step executable; mock cannot satisfy wire contracts",
  timeout: 180000,
};
const endpoint = (protocol) =>
  protocol === protocols[0]
    ? "/v1/chat/completions"
    : protocol === protocols[1]
      ? "/v1/responses"
      : "/v1/messages";
const nativeOptions = (protocol) => ({
  ...(protocol === protocols[0]
    ? {
        compat: {
          supportsStore: false,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
          supportsStrictMode: false,
        },
        samplingParams: { parallel_tool_calls: false, fixture_extra: 42 },
      }
    : {}),
  ...(protocol === protocols[1]
    ? {
        compat: { supportsStrictMode: false },
        samplingParams: { parallel_tool_calls: false, fixture_extra: 42 },
      }
    : {}),
  ...(protocol === protocols[2]
    ? { compat: { supportsEagerToolInputStreaming: false, supportsTemperature: false } }
    : {}),
});

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertSuccess(events, expected) {
  const message = assistant(events);
  assert.equal(message?.stopReason, "stop", message?.errorMessage || JSON.stringify(events.at(-1)));
  assert.equal(messageText(message), expected);
  assert.equal(events.at(-1)?.type, "agent_settled");
  return message;
}

function assertImage(protocol, body) {
  if (protocol === protocols[0]) {
    const part = body.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block.type === "image_url");
    assert.equal(part?.image_url?.url, `data:image/png;base64,${imageData}`);
  } else if (protocol === protocols[1]) {
    const part = body.input
      .flatMap((item) => item.content || [])
      .find((block) => block.type === "input_image");
    assert.equal(part?.image_url, `data:image/png;base64,${imageData}`);
  } else {
    const part = body.messages
      .flatMap((message) => message.content || [])
      .find((block) => block.type === "image");
    assert.deepEqual(part?.source, { type: "base64", media_type: "image/png", data: imageData });
  }
}

// 同一协议会话覆盖文本/工具/图片/失败/取消；各协议独立 HOME、agent dir、服务和模型 id。
for (const protocol of protocols)
  test(`installed Step wire contract: ${protocol}`, options, async (t) => {
    const http = await httpFixture(protocol);
    t.after(() => http.close());
    const fixture = await projectedClient(protocol, http.baseUrl, {
      native: nativeOptions(protocol),
    });
    const { client, root, marker, providerId, modelId, document } = fixture;
    const evidence = {
      protocol,
      cli: installedCli,
      selection: { providerId, modelId },
      cases: [],
      document,
      requests: http.requests,
    };
    t.after(async () => {
      await client.stop();
      if (process.env.STEP_WIRE_EVIDENCE_DIR) {
        await mkdir(process.env.STEP_WIRE_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          join(process.env.STEP_WIRE_EVIDENCE_DIR, `${protocol}.json`),
          JSON.stringify({ ...evidence, fixtureErrors: http.errors }, null, 2),
        );
      }
      await rm(root, { recursive: true, force: true });
    });
    await client.start();
    const catalog = await client.getAvailableModels();
    const model = catalog.find((item) => item.provider === providerId && item.id === modelId);
    assert.ok(model, "native models.json loader must accept the projection and ownership metadata");
    await client.setModel(providerId, modelId);
    await client.request({ type: "set_auto_retry", enabled: false });
    await client.setThinkingLevel("high");

    async function check(name, run) {
      await t.test(name, async () => {
        try {
          const result = await run();
          evidence.cases.push({ name, passed: true, result });
        } catch (error) {
          evidence.cases.push({ name, passed: false, error: error.message });
          throw error;
        }
      });
    }
    for (const newline of ["\n", "\r\n"])
      await check(
        `${newline === "\n" ? "LF" : "CRLF"} fragmented UTF8 text, usage-only and terminal`,
        async () => {
          http.set({ kind: "text", text: "WIRE_TEXT_测🙂", newline });
          const events = await client.promptAndWait("WIRE_TEXT", { timeoutMs: 15000 });
          const message = assertSuccess(events, "WIRE_TEXT_测🙂");
          assert.equal(message.usage.totalTokens, 12);
          assert.equal(http.requests.at(-1).path, endpoint(protocol));
          assert.equal(http.requests.at(-1).body.model, modelId);
          return {
            stopReason: message.stopReason,
            usage: message.usage,
            nativeToolNames: http.requests[0].body.tools.map(
              (tool) => (tool.function ?? tool).name,
            ),
          };
        },
      );
    await check(
      "native read-only tool_call → isolated marker → tool_result → final reply (LF)",
      async () => {
        const tool = readTool(http.requests[0].body, marker);
        http.set({ kind: "tool", ...tool, text: "WIRE_TOOL_FINAL_测🙂", newline: "\n" });
        const before = http.requests.length;
        const events = await client.promptAndWait(
          "WIRE_TOOL: read the fixture marker using the registered read tool",
          { timeoutMs: 20000 },
        );
        assertSuccess(events, "WIRE_TOOL_FINAL_测🙂");
        const calls = http.requests.slice(before);
        assert.equal(
          calls.length,
          2,
          "a single tool roundtrip must trigger exactly one continuation",
        );
        assert.ok(hasToolResult(protocol, calls[1].body));
        assert.ok(
          JSON.stringify(calls[1].body).includes(markerText),
          "HTTP tool result must contain the file content, not a fabricated final reply",
        );
        const execution = events.find((event) => event.type === "tool_execution_end");
        assert.ok(execution, "native tool execution event required");
        assert.equal(execution.isError, false, JSON.stringify(execution));
        assert.ok(JSON.stringify(execution).includes(markerText));
        return {
          tool: tool.name,
          toolResultObserved: true,
          eventTypes: events.map((event) => event.type),
        };
      },
    );
    await check(
      "image uses protocol-correct data URL/base64 and returns native completion",
      async () => {
        http.set({ kind: "image", text: "WIRE_IMAGE_FINAL", newline: "\n" });
        const events = await client.promptAndWait("WIRE_IMAGE", {
          images: [{ type: "image", data: imageData, mimeType: "image/png" }],
          timeoutMs: 15000,
        });
        assertSuccess(events, "WIRE_IMAGE_FINAL");
        assertImage(protocol, http.requests.at(-1).body);
        return { imageDelivered: true };
      },
    );
    await check(
      "production projection: model/provider headers, precedence, context/output/reasoning and strict request",
      async () => {
        const projected = document.providers[providerId],
          entry = projected.models[0];
        assert.equal(entry.contextWindow, 24576);
        assert.equal(entry.maxTokens, 2048);
        assert.equal(entry.reasoning, true);
        assert.deepEqual(entry.thinkingLevelMap, { high: "high" });
        assert.equal(model.contextWindow, 24576);
        assert.equal(model.maxTokens, 2048);
        assert.equal(model.reasoning, true);
        assert.equal(document._stepcodeDesktopProviders?.version, 1);
        http.set({
          kind: "strict",
          text: "WIRE_STRICT_FINAL",
          newline: "\n",
          strict: protocol === protocols[0],
        });
        const events = await client.promptAndWait("WIRE_STRICT", { timeoutMs: 15000 });
        assertSuccess(events, "WIRE_STRICT_FINAL");
        const request = http.requests.at(-1);
        assert.equal(request.headers["x-wire-provider"], "provider");
        assert.equal(request.headers["x-wire-model"], "model");
        assert.equal(request.headers["x-wire-priority"], "model");
        if (protocol === protocols[0]) {
          assert.equal(request.body.max_tokens, 2048);
          assert.equal(request.body.reasoning_effort, "high");
          assert.equal(request.body.parallel_tool_calls, false);
          assert.equal(request.body.fixture_extra, 42);
          for (const field of ["store", "stream_options", "max_completion_tokens"])
            assert.equal(field in request.body, false);
        } else if (protocol === protocols[1]) {
          assert.equal(request.body.max_output_tokens, 2048);
          assert.equal(request.body.reasoning?.effort, "high");
          assert.equal(request.body.parallel_tool_calls, false);
          assert.equal(request.body.fixture_extra, 42);
        } else {
          assert.ok(request.body.max_tokens >= 2048);
          assert.ok(
            request.body.thinking,
            "reasoning projection must produce Anthropic thinking options",
          );
          assert.equal("temperature" in request.body, false);
        }
        return {
          headers: request.headers,
          bodyKeys: Object.keys(request.body),
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        };
      },
    );
    for (const status of [401, 429, 503])
      await check(`HTTP ${status} settles as error, never success`, async () => {
        http.set({ kind: "http-error", status });
        const events = await client.promptAndWait(`WIRE_HTTP_${status}`, { timeoutMs: 30000 });
        const message = assistant(events);
        assert.equal(message?.stopReason, "error", JSON.stringify(message));
        assert.match(message.errorMessage, new RegExp(`WIRE_HTTP_${status}|${status}`));
        assert.equal(events.at(-1).type, "agent_settled");
        return { stopReason: message.stopReason, error: message.errorMessage };
      });
    await check("SSE error cannot be a successful terminal", async () => {
      http.set({ kind: "stream-error" });
      const events = await client.promptAndWait("WIRE_SSE_ERROR", { timeoutMs: 15000 });
      const message = assistant(events);
      assert.equal(message?.stopReason, "error", JSON.stringify(message));
      assert.match(message.errorMessage, /WIRE_STREAM_ERROR/);
      return { stopReason: message.stopReason, error: message.errorMessage };
    });
    await check("slow stream abort releases turn and next call succeeds", async () => {
      http.set({ kind: "slow", text: "WIRE_SLOW_PARTIAL", newline: "\n" });
      const count = http.requests.length;
      let partial = "";
      const unsubscribe = client.onEvent((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
          partial += event.assistantMessageEvent.delta;
      });
      const pending = client.promptAndWait("WIRE_SLOW", { timeoutMs: 15000 });
      pending.catch(() => {});
      await waitUntil(() => http.requests.length > count, "slow HTTP request");
      try {
        await waitUntil(
          () => partial.includes("WIRE_SLOW_PARTIAL"),
          "native partial text before abort",
        );
      } finally {
        unsubscribe();
      }
      await client.abort();
      const events = await pending;
      assert.equal(assistant(events)?.stopReason, "aborted", JSON.stringify(assistant(events)));
      await waitUntil(
        () => http.closed.some((request) => request.action === "slow"),
        "aborted HTTP response close",
      );
      assert.equal((await client.getState()).isStreaming, false);
      http.set({ kind: "after-abort", text: "WIRE_AFTER_ABORT", newline: "\n" });
      assertSuccess(
        await client.promptAndWait("WIRE_AFTER_ABORT", { timeoutMs: 15000 }),
        "WIRE_AFTER_ABORT",
      );
      assert.equal(http.errors.length, 0, JSON.stringify(http.errors));
      return { partialObserved: partial, aborted: true, nextCallSucceeded: true };
    });
  });

for (const protocol of protocols)
  for (const authMode of ["none", "headers"])
    test(`installed Step wire auth: ${protocol} ${authMode}`, options, async (t) => {
      const http = await httpFixture(protocol);
      t.after(() => http.close());
      const fixture = await projectedClient(protocol, http.baseUrl, {
        access: { apiKey: undefined },
        api: {
          authMode,
          headers: authMode === "headers" ? { Authorization: "Custom fixture-wire" } : {},
        },
        native: { reasoning: false, thinkingLevelMap: {} },
      });
      const { client, root, providerId, modelId } = fixture;
      t.after(async () => {
        await client.stop();
        await rm(root, { recursive: true, force: true });
      });
      await client.start();
      await client.setModel(providerId, modelId);
      http.set({ kind: "auth", text: "WIRE_AUTH_FINAL", newline: "\n" });
      let message,
        passed = false;
      try {
        message = assertSuccess(
          await client.promptAndWait("WIRE_AUTH", { timeoutMs: 15000 }),
          "WIRE_AUTH_FINAL",
        );
        const request = http.requests.at(-1);
        assert.equal(request.path, endpoint(protocol));
        assert.equal(
          request.headers.authorization,
          authMode === "headers" ? "Custom fixture-wire" : undefined,
        );
        assert.equal(request.headers["x-api-key"], undefined);
        assert.equal(
          JSON.stringify(request.headers).includes("internal_auth_gate"),
          false,
          "native availability sentinel must never be transmitted",
        );
        assert.equal(http.errors.length, 0, JSON.stringify(http.errors));
        passed = true;
      } finally {
        if (process.env.STEP_WIRE_EVIDENCE_DIR) {
          await mkdir(process.env.STEP_WIRE_EVIDENCE_DIR, { recursive: true });
          await writeFile(
            join(process.env.STEP_WIRE_EVIDENCE_DIR, `${protocol}-${authMode}.json`),
            JSON.stringify(
              {
                protocol,
                authMode,
                passed,
                result: { stopReason: message?.stopReason, text: messageText(message) },
                cli: installedCli,
                document: fixture.document,
                requests: http.requests,
                fixtureErrors: http.errors,
              },
              null,
              2,
            ),
          );
        }
      }
    });
