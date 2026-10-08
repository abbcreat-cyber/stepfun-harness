import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { communicationBinding, communicationFetch } from "../src/provider-communication.mjs";
import { normalizeSseResponse } from "../src/provider-sse-transport.mjs";
import {
  hasMappedProviderOptions,
  prepareProviderRequestOptions,
  discardProviderRequestOptions,
} from "../src/provider-request-options.mjs";
import { httpFixture, protocols, assistant } from "./provider-wire-fixtures.mjs";

test("option transport skips non-native fixture clients", async () => {
  const fixture = {
    options: { command: ["node", "mock.mjs"], communicationMode: "mock" },
    request() {
      throw new Error("mock must not receive extension commands");
    },
  };
  assert.equal(
    (await hasMappedProviderOptions(fixture, { providerId: "fixture", modelId: "model" }))
      .hasMappings,
    false,
  );
  assert.equal(
    (await prepareProviderRequestOptions({}, { providerId: "fixture", modelId: "model" }))
      .hasMappings,
    false,
  );
});

test("fetch guard preserves the original custom fetch, Request and extended RequestInit", async () => {
  const model = {
    provider: "fetch-fixture",
    id: "fetch-model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    compat: {
      stepcodeDesktop: {
        version: 1,
        providerId: "fetch-fixture",
        modelId: "fetch-model",
        protocol: "openai-completions",
        apiRoot: "http://127.0.0.1:1/v1",
        authMode: "api-key",
      },
    },
  };
  const request = new Request("http://127.0.0.1:1/v1/chat/completions", {
    method: "POST",
    body: "{}",
  });
  const signal = new AbortController().signal,
    dispatcher = {},
    proxy = { fixture: true };
  const guarded = communicationFetch(
    async (input, init) => {
      assert.equal(input, request);
      assert.equal(init.dispatcher, dispatcher);
      assert.equal(init.proxy, proxy);
      assert.equal(init.signal, signal);
      assert.equal(init.duplex, "half");
      return new Response("CUSTOM_FETCH_OK");
    },
    model,
    communicationBinding(model),
  );
  const response = await guarded(request, { dispatcher, proxy, signal, duplex: "half" });
  assert.equal(await response.text(), "CUSTOM_FETCH_OK");
});

test("SSE byte normalization preserves UTF8, CR across chunks, status and cancellation", async () => {
  const bytes = Buffer.from("event: text\r\ndata: 测🙂\r\n\r\ndata: end\r");
  let offset = 0,
    cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = normalizeSseResponse(
    new Response(body, {
      status: 201,
      headers: { "Content-Type": "text/event-stream", "X-Fixture": "kept" },
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("X-Fixture"), "kept");
  assert.equal(await response.text(), "event: text\ndata: 测🙂\n\ndata: end\n");
  const streaming = normalizeSseResponse(
    new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array([13]));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const reader = streaming.body.getReader();
  await reader.cancel("test");
  assert.equal(cancelled, true);
});

for (const protocol of protocols)
  test(
    `installed provider option maps: ${protocol}`,
    {
      skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI; real Step required",
      timeout: 90000,
    },
    async (t) => {
      const http = await httpFixture(protocol);
      t.after(() => http.close());
      const base = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-option-tests";
      await mkdir(base, { recursive: true });
      const root = await mkdtemp(join(base, "options-"));
      await mkdir(join(root, "agent"));
      const api = protocol === protocols[0] ? "openai-completions" : protocol;
      const selection = { providerId: "option-fixture", modelId: "option-model" };
      const metadata = {
        version: 1,
        ...selection,
        protocol: api,
        apiRoot: http.baseUrl,
        authMode: "none",
        supportsToolCall: false,
        optionSpecs: {
          reasoningLevel: {
            values: ["disabled", "enabled", "low"],
            map: '{"fixture_reasoning":reasoningLevel,"reasoning_effort":null,"thinking":null}',
          },
          maxOutputTokens: {
            max: 512,
            map: '{"max_completion_tokens":null,"max_output_tokens":null,"max_tokens":maxOutputTokens,"fixture_limit":maxOutputTokens}',
          },
        },
      };
      const document = {
        providers: {
          [selection.providerId]: {
            api,
            baseUrl: http.baseUrl,
            apiKey: "__stepcode_internal_auth_gate__",
            authHeader: false,
            models: [
              {
                id: selection.modelId,
                reasoning: true,
                contextWindow: 16384,
                maxTokens: 1024,
                compat: { stepcodeDesktop: metadata },
              },
            ],
          },
        },
      };
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        STEP_CODING_AGENT_DIR: join(root, "agent"),
        NO_PROXY: "127.0.0.1,localhost",
      };
      for (const name of Object.keys(env))
        if (/API_KEY|TOKEN|SECRET|PROXY/i.test(name) && name !== "NO_PROXY") delete env[name];
      const evidence = { protocol, cases: [], requests: http.requests };
      let client;
      const start = async () => {
        await writeFile(join(root, "models.json"), JSON.stringify(document));
        client = new StepCodeRpcClient({
          command: [
            process.env.STEP_TEST_CLI,
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-tools",
          ],
          cwd: root,
          env,
          requestTimeoutMs: 15000,
        });
        await client.start();
        await client.setModel(selection.providerId, selection.modelId);
        await client.request({ type: "set_auto_retry", enabled: false });
      };
      t.after(async () => {
        await client?.stop();
        if (process.env.STEP_WIRE_EVIDENCE_DIR) {
          await mkdir(process.env.STEP_WIRE_EVIDENCE_DIR, { recursive: true });
          await writeFile(
            join(process.env.STEP_WIRE_EVIDENCE_DIR, `options-${protocol}.json`),
            JSON.stringify(evidence, null, 2),
          );
        }
        await rm(root, { recursive: true, force: true });
      });
      await start();
      await client.setThinkingLevel("high");
      const check = (name, run) =>
        t.test(name, async () => {
          try {
            await run();
            evidence.cases.push({ name, passed: true });
          } catch (error) {
            evidence.cases.push({ name, passed: false, error: error.message });
            throw error;
          }
        });
      const prepare = (reasoningLevel, requestId) =>
        prepareProviderRequestOptions(client, {
          ...selection,
          options: { reasoningLevel },
          requestId,
        });
      const send = async () => {
        const events = await client.promptAndWait("OPTION_TEXT", { timeoutMs: 15000 });
        assert.equal(assistant(events)?.stopReason, "stop", assistant(events)?.errorMessage);
        return http.requests.at(-1).body;
      };
      await check(
        "capability and three original desktop enum values are mapped without a chat command",
        async () => {
          const capability = await hasMappedProviderOptions(client, selection);
          assert.equal(capability.reasoningMapped, true);
          assert.equal(capability.maxOutputMapped, true);
          const generation = capability.generation;
          for (const reasoningLevel of ["disabled", "enabled", "low"]) {
            const before = http.requests.length,
              history = await client.getMessages();
            const receipt = await prepare(reasoningLevel, `map-${reasoningLevel}`);
            assert.equal(receipt.generation, generation);
            assert.equal(http.requests.length, before);
            assert.deepEqual(await client.getMessages(), history);
            const body = await send();
            assert.equal(body.fixture_reasoning, reasoningLevel);
            assert.equal(body.fixture_limit, 512);
            assert.equal(body.max_tokens, 512);
            for (const field of [
              "max_completion_tokens",
              "max_output_tokens",
              "thinking",
              "reasoning_effort",
            ])
              assert.ok(!(field in body));
          }
        },
      );
      await check("unprepared and undeclared mapped values fail with zero HTTP", async () => {
        const before = http.requests.length;
        const events = await client.promptAndWait("UNPREPARED_OPTION_TEXT", { timeoutMs: 15000 });
        assert.equal(assistant(events)?.stopReason, "error");
        assert.match(assistant(events)?.errorMessage, /not prepared/);
        assert.equal(http.requests.length, before);
        await assert.rejects(prepare("unknown", "invalid-option"), /original declared/);
        assert.equal(http.requests.length, before);
        await prepare("low", "valid-after-rejected-option");
        assert.equal((await send()).fixture_reasoning, "low");
      });
      await check(
        "binding receipt errors and matching discard preserve the next valid prompt",
        async () => {
          const before = http.requests.length;
          await assert.rejects(
            hasMappedProviderOptions(client, { ...selection, modelId: "wrong-model" }),
            /binding/,
          );
          await prepare("enabled", "discard-this-prepared");
          await discardProviderRequestOptions(client, {
            ...selection,
            requestId: "discard-this-prepared",
          });
          assert.equal(http.requests.length, before);
          await prepare("disabled", "valid-after-discard");
          assert.equal((await send()).fixture_reasoning, "disabled");
        },
      );
      await check(
        "busy rejects transport mutation; abort clears the next prompt binding",
        async () => {
          await prepare("enabled", "abort-current");
          http.set({ kind: "slow", text: "IN_FLIGHT", newline: "\r\n" });
          const before = http.requests.length,
            pending = client.promptAndWait("OPTION_BUSY", { timeoutMs: 15000 });
          const deadline = Date.now() + 5000;
          while (http.requests.length === before) {
            if (Date.now() > deadline) throw new Error("Busy request not observed");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await assert.rejects(prepare("low", "must-not-change-active"), /busy/);
          await client.abort();
          await pending;
          http.set({ kind: "text", text: "WIRE_TEXT_测🙂", newline: "\r\n" });
          await prepare("low", "after-abort");
          assert.equal((await send()).fixture_reasoning, "low");
        },
      );
      await client.stop();
      metadata.optionSpecs.reasoningLevel.values = ["off", "enabled"];
      await start();
      await check(
        "native automatic retry retains the same prompt binding and the next prompt requires preparation",
        async () => {
          await client.request({ type: "set_auto_retry", enabled: true });
          await prepare("off", "review-retry");
          http.set({ kind: "http-error", status: 503 });
          const before = http.requests.length;
          let retryObserved = false;
          const off = client.onEvent((event) => {
            if (event.type === "auto_retry_start") {
              retryObserved = true;
              http.set({ kind: "text", text: "WIRE_TEXT_测🙂", newline: "\r\n" });
            }
          });
          try {
            await send();
          } finally {
            off();
          }
          const requests = http.requests.slice(before);
          assert.equal(retryObserved, true);
          assert.ok(requests.length >= 2);
          for (const request of requests) assert.equal(request.body.fixture_reasoning, "off");
          const afterRetry = http.requests.length;
          const events = await client.promptAndWait("NEW_UNPREPARED_PROMPT", { timeoutMs: 15000 });
          assert.equal(assistant(events)?.stopReason, "error");
          assert.equal(http.requests.length, afterRetry);
          await prepare("enabled", "after-retry");
          assert.equal((await send()).fixture_reasoning, "enabled");
          await client.request({ type: "set_auto_retry", enabled: false });
        },
      );
      await client.stop();
      metadata.optionSpecs.reasoningLevel.map = '{"model":"must-not-override"}';
      await start();
      await check("a compiled map cannot overwrite protocol identity", async () => {
        await prepare("enabled", "protected-map");
        const before = http.requests.length;
        const events = await client.promptAndWait("PROTECTED_MAP", { timeoutMs: 15000 });
        assert.equal(assistant(events)?.stopReason, "error");
        assert.match(assistant(events)?.errorMessage, /protected/);
        assert.equal(http.requests.length, before);
      });
    },
  );
