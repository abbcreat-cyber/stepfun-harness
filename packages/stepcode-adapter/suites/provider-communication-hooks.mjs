import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import {
  COMMUNICATION_COMMAND,
  COMMUNICATION_DESCRIPTION,
  applyCommunicationHeaders,
  applyCommunicationPayload,
  assertProviderCommunicationLoaded,
  communicationBinding,
  communicationFetch,
  withProviderCommunication,
} from "../src/provider-communication.mjs";
import { httpFixture, protocols, assistant, messageText } from "./provider-wire-fixtures.mjs";

const cli = process.env.STEP_TEST_CLI;
const nativeApi = (protocol) => (protocol === protocols[0] ? "openai-completions" : protocol);
const metadata = (api, baseUrl, mode = "none") => ({
  version: 1,
  providerId: "hooks-fixture",
  modelId: "hooks-model",
  protocol: api,
  apiRoot: baseUrl,
  authMode: mode,
  supportsToolCall: false,
});
const model = (mode = "none") => ({
  id: "hooks-model",
  provider: "hooks-fixture",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1/v1",
  headers: { Authorization: "Custom fixture", "X-Extra": "kept" },
  compat: { stepcodeDesktop: metadata("openai-completions", "http://127.0.0.1:1/v1", mode) },
});

test("communication binding validates native identity, root and startup generation", () => {
  const initial = model(),
    binding = communicationBinding(initial);
  assert.equal(binding.authMode, "none");
  assert.throws(() => communicationBinding({ ...initial, provider: "other" }), /binding/i);
  assert.throws(
    () => communicationBinding({ ...initial, baseUrl: "http://127.0.0.1:2/v1" }),
    /binding/i,
  );
  assert.throws(
    () =>
      communicationBinding({
        ...initial,
        compat: { stepcodeDesktop: { ...initial.compat.stepcodeDesktop, version: 2 } },
      }),
    /version/i,
  );
});

test("none removes default authentication; headers mode preserves explicit auth case insensitively", () => {
  const headers = { Authorization: "Bearer gate", "x-api-key": "gate", "X-Extra": "kept" };
  applyCommunicationHeaders(headers, model(), communicationBinding(model()));
  assert.equal(headers.Authorization, null);
  assert.equal(headers["x-api-key"], null);
  assert.equal(headers["X-Extra"], "kept");
  const custom = model("headers");
  custom.headers.authorization = "Model custom";
  applyCommunicationHeaders(headers, custom, communicationBinding(custom));
  assert.equal(headers.Authorization, "Model custom");
  assert.equal(headers["x-api-key"], null);
});

test("only Anthropic needs sampling patch; tool-free payload retains protocol identity", () => {
  const initial = model();
  initial.api = "anthropic-messages";
  initial.compat.stepcodeDesktop.protocol = initial.api;
  initial.samplingParams = { fixture_extra: 42, temperature: 0.2 };
  const payload = {
    model: initial.id,
    messages: [],
    stream: true,
    tools: [],
    tool_choice: { type: "auto" },
    parallel_tool_calls: false,
  };
  const patched = applyCommunicationPayload(payload, initial, communicationBinding(initial));
  assert.equal(patched.fixture_extra, 42);
  assert.equal(patched.stream, true);
  assert.deepEqual(patched.messages, []);
  for (const key of ["tools", "tool_choice", "parallel_tool_calls"]) assert.ok(!(key in patched));
  initial.samplingParams = { messages: [] };
  assert.throws(
    () => applyCommunicationPayload(payload, initial, communicationBinding(initial)),
    /protected/i,
  );
});

test("only Step commands receive a deduplicated explicit extension", () => {
  assert.deepEqual(withProviderCommunication(["node", "mock.mjs"], { communicationMode: "mock" }), [
    "node",
    "mock.mjs",
  ]);
  const command = withProviderCommunication(["step.exe", "--no-extensions"]);
  assert.deepEqual(withProviderCommunication(command), command);
  assert.ok(command.includes("--extension"));
});

test("missing capability and final fetch binding errors fail closed", async () => {
  await assert.rejects(
    assertProviderCommunicationLoaded({
      options: { command: ["step.exe"] },
      async getCommands() {
        return [];
      },
    }),
    /blocked/,
  );
  await assertProviderCommunicationLoaded({
    options: { command: ["step.exe"] },
    async getCommands() {
      return [
        {
          name: COMMUNICATION_COMMAND,
          description: COMMUNICATION_DESCRIPTION,
          source: "extension",
        },
      ];
    },
  });
  let requests = 0;
  const initial = model("headers"),
    fetch = communicationFetch(
      async () => {
        requests++;
        return new Response("ok");
      },
      initial,
      communicationBinding(initial),
    );
  await assert.rejects(
    fetch("http://127.0.0.1:2/v1/chat/completions", { headers: {} }),
    /HTTP target/,
  );
  assert.equal(requests, 0);
  const noAuth = model();
  noAuth.headers = {};
  const observe = communicationFetch(
    async (_input, options) => {
      requests++;
      assert.equal(options.headers.has("Authorization"), false);
      assert.equal(options.headers.has("x-api-key"), false);
      return new Response("ok");
    },
    noAuth,
    communicationBinding(noAuth),
  );
  await observe("http://127.0.0.1:1/v1/chat/completions", {
    headers: {
      Authorization: "Bearer __stepcode_internal_auth_gate__",
      "x-api-key": "__stepcode_internal_auth_gate__",
    },
  });
  assert.equal(requests, 1);
});

for (const protocol of protocols)
  test(
    `installed provider hooks: ${protocol}`,
    { skip: !cli && "Set STEP_TEST_CLI; real Step required", timeout: 90000 },
    async (t) => {
      const http = await httpFixture(protocol);
      t.after(() => http.close());
      const base = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-hook-tests";
      await mkdir(base, { recursive: true });
      const root = await mkdtemp(join(base, "hooks-"));
      const agent = join(root, "agent");
      await mkdir(agent);
      const api = nativeApi(protocol),
        records = [];
      let client;
      const original = {
        api,
        baseUrl: http.baseUrl,
        apiKey: "__stepcode_internal_auth_gate__",
        authHeader: false,
        headers: { "X-Provider": "provider", "X-Priority": "provider" },
        models: [
          {
            id: "hooks-model",
            reasoning: false,
            contextWindow: 16384,
            maxTokens: 1024,
            headers: { "X-Model": "model", "X-Priority": "model" },
            samplingParams: { fixture_extra: 42 },
            compat: { stepcodeDesktop: metadata(api, http.baseUrl) },
          },
        ],
      };
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        STEP_CODING_AGENT_DIR: agent,
        NO_PROXY: "127.0.0.1,localhost",
      };
      for (const key of Object.keys(env))
        if (/API_KEY|TOKEN|SECRET|PROXY/i.test(key) && key !== "NO_PROXY") delete env[key];
      const save = (value) =>
        writeFile(
          join(root, "models.json"),
          JSON.stringify({ providers: { "hooks-fixture": value } }),
        );
      const start = async () => {
        client = new StepCodeRpcClient({
          command: [cli, "--mode", "rpc", "--no-session", "--no-extensions"],
          cwd: root,
          env,
          requestTimeoutMs: 15000,
        });
        await client.start();
        await client.setModel("hooks-fixture", "hooks-model");
        await client.request({ type: "set_auto_retry", enabled: false });
      };
      t.after(async () => {
        await client?.stop();
        if (process.env.STEP_WIRE_EVIDENCE_DIR) {
          await mkdir(process.env.STEP_WIRE_EVIDENCE_DIR, { recursive: true });
          await writeFile(
            join(process.env.STEP_WIRE_EVIDENCE_DIR, `hooks-${protocol}.json`),
            JSON.stringify(
              { cli, protocol, records, requests: http.requests, stderr: client?.getStderr() },
              null,
              2,
            ),
          );
        }
        await rm(root, { recursive: true, force: true });
      });
      const check = async (name, run) =>
        t.test(name, async () => {
          try {
            await run();
            records.push({ name, passed: true });
          } catch (e) {
            records.push({ name, passed: false, error: e.message });
            throw e;
          }
        });
      const send = async () => {
        const events = await client.promptAndWait("HOOK_TEXT", { timeoutMs: 15000 });
        const reply = assistant(events);
        assert.equal(reply?.stopReason, "stop", reply?.errorMessage);
        assert.equal(messageText(reply), "WIRE_TEXT_测🙂");
        return http.requests.at(-1);
      };
      await save(original);
      await start();
      await check(
        "public extension command receipt creates no turn, history or queue item",
        async () => {
          const history = await client.getMessages(),
            before = http.requests.length,
            events = [];
          const off = client.onEvent((event) => events.push(event));
          try {
            await client.request({
              type: "prompt",
              message: `/${COMMUNICATION_COMMAND} ${JSON.stringify({ requestId: "command-proof" })}`,
            });
            assert.deepEqual(await client.getMessages(), history);
            assert.deepEqual(await client.clearQueue(), { steering: [], followUp: [] });
            const receipt = events.find(
              (event) =>
                event.method === "setStatus" &&
                event.statusKey === "stepcode-provider-options-receipt",
            );
            assert.equal(JSON.parse(receipt?.statusText).requestId, "command-proof");
            assert.equal(
              events.some((event) =>
                ["agent_start", "message_start", "userInput"].includes(event.type),
              ),
              false,
            );
            assert.equal(http.requests.length, before);
          } finally {
            off();
          }
        },
      );
      await check("none sends no default auth, Anthropic sampling and tool-free body", async () => {
        const request = await send();
        for (const key of ["authorization", "x-api-key", "cf-aig-authorization"])
          assert.ok(!(key in request.headers));
        assert.equal(request.headers["x-priority"], "model");
        assert.equal(request.body.fixture_extra, 42);
        assert.equal(
          request.body[
            api === "openai-responses"
              ? "max_output_tokens"
              : api === "anthropic-messages"
                ? "max_tokens"
                : "max_completion_tokens"
          ],
          1024,
        );
        for (const key of ["tools", "tool_choice", "parallel_tool_calls"])
          assert.ok(!(key in request.body));
        assert.ok(!JSON.stringify(request.headers).includes("__stepcode_internal_auth_gate__"));
      });
      const changed = structuredClone(original);
      changed.headers.Authorization = "Provider custom";
      changed.models[0].headers.authorization = "Model custom";
      changed.models[0].compat.stepcodeDesktop.authMode = "headers";
      await check("busy startup snapshot isolates live models edits", async () => {
        http.set({ kind: "slow", text: "IN_FLIGHT", newline: "\r\n" });
        const before = http.requests.length,
          pending = client.promptAndWait("HOOK_BUSY", { timeoutMs: 15000 });
        const deadline = Date.now() + 5000;
        while (http.requests.length === before) {
          if (Date.now() > deadline) throw new Error("Busy fixture request not observed");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await save(changed);
        await client.abort();
        await pending;
        http.set({ kind: "text", text: "WIRE_TEXT_测🙂", newline: "\r\n" });
        const request = await send();
        assert.ok(!("authorization" in request.headers));
      });
      await client.stop();
      await start();
      await check("header-only preserves model auth priority, deletes other SDK auth", async () => {
        const request = await send();
        assert.equal(request.headers.authorization, "Model custom");
        assert.ok(!("x-api-key" in request.headers));
      });
      await client.stop();
      const keyed = structuredClone(original);
      keyed.apiKey = "sk-fixture-hook";
      keyed.models[0].compat.stepcodeDesktop.authMode = "api-key";
      await save(keyed);
      await start();
      await check("api-key preserves native default credential authentication", async () => {
        const request = await send();
        assert.equal(
          request.headers[api === "anthropic-messages" ? "x-api-key" : "authorization"],
          api === "anthropic-messages" ? "sk-fixture-hook" : "Bearer sk-fixture-hook",
        );
      });
      await client.stop();
      changed.models[0].samplingParams = { model: "override-must-not-send" };
      await save(changed);
      await start();
      await check(
        "protected sampling error ends in original SDK failure with zero HTTP",
        async () => {
          const before = http.requests.length;
          const events = await client.promptAndWait("HOOK_INVALID_PARAMETERS", {
            timeoutMs: 15000,
          });
          assert.equal(assistant(events)?.stopReason, "error");
          assert.match(assistant(events)?.errorMessage, /protected|identity/);
          assert.equal(http.requests.length, before);
        },
      );
      await client.stop();
      changed.models[0].compat.stepcodeDesktop.apiRoot = "http://127.0.0.1:1/v1";
      await save(changed);
      await check("invalid metadata binding fails startup before HTTP", async () => {
        const before = http.requests.length;
        await assert.rejects(start(), /communication|binding|extension/i);
        assert.equal(http.requests.length, before);
      });
    },
  );
