import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import {
  prepareProviderRequestOptions,
  carryProviderRequestOptions,
} from "../src/provider-request-options.mjs";
import { textEvents, protocols, assistant } from "./provider-wire-fixtures.mjs";

test(
  "carry distinguishes initial ACK, real continuation, abort and unprepared new prompts",
  { timeout: 20000 },
  async () => {
    const base = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-carry-tests";
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "carry-unit-"));
    try {
      // 聚合 runner 已装载多个 loader namespace；纯 unit 通过独立进程保留全部断言。
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./fixtures/provider-options-carry-unit.mjs", import.meta.url)),
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root },
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.match(stdout, /provider-options-carry-unit: passed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "installed same-option steer and busy-to-idle race retain explicit values without leakage",
  {
    skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI; real Step required",
    timeout: 60000,
  },
  async (t) => {
    const rootBase = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-carry-tests";
    await mkdir(rootBase, { recursive: true });
    const root = await mkdtemp(join(rootBase, "carry-"));
    await mkdir(join(root, "agent"));
    const requests = [];
    let hold = true,
      release;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const events = textEvents(protocols[0], "CARRY_OK"),
        emit = (item) =>
          res.write(`data: ${typeof item === "string" ? item : JSON.stringify(item)}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (hold) {
        hold = false;
        emit(events[0]);
        emit(events[1]);
        release = () => {
          for (const item of events.slice(2)) emit(item);
          res.end();
        };
      } else {
        for (const item of events) emit(item);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`,
      selection = {
        providerId: "carry-fixture",
        modelId: "carry-model",
        options: { reasoningLevel: "low" },
      };
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          [selection.providerId]: {
            api: "openai-completions",
            baseUrl,
            apiKey: "__stepcode_internal_auth_gate__",
            authHeader: false,
            models: [
              {
                id: selection.modelId,
                reasoning: true,
                contextWindow: 32768,
                maxTokens: 512,
                compat: {
                  stepcodeDesktop: {
                    version: 1,
                    providerId: selection.providerId,
                    modelId: selection.modelId,
                    protocol: "openai-completions",
                    apiRoot: baseUrl,
                    authMode: "none",
                    supportsToolCall: false,
                    optionSpecs: {
                      reasoningLevel: { values: ["low"], map: '{"fixture_map":reasoningLevel}' },
                    },
                  },
                },
              },
            ],
          },
        },
      }),
    );
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      STEP_CODING_AGENT_DIR: join(root, "agent"),
      NO_PROXY: "127.0.0.1,localhost",
    };
    for (const name of Object.keys(env))
      if (/API_KEY|TOKEN|SECRET|PROXY/i.test(name) && name !== "NO_PROXY") delete env[name];
    const client = new StepCodeRpcClient({
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
    t.after(async () => {
      await client.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (process.env.STEP_WIRE_EVIDENCE_DIR) {
        await mkdir(process.env.STEP_WIRE_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          join(process.env.STEP_WIRE_EVIDENCE_DIR, "carry-openai-completions.json"),
          JSON.stringify({ requests }, null, 2),
        );
      }
      await rm(root, { recursive: true, force: true });
    });
    await client.start();
    await client.setModel(selection.providerId, selection.modelId);
    await client.request({ type: "set_auto_retry", enabled: false });
    const waitRequest = async (count) => {
      const deadline = Date.now() + 5000;
      while (requests.length < count) {
        if (Date.now() > deadline) throw new Error("Carry HTTP fixture was not reached");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await prepareProviderRequestOptions(client, { ...selection, requestId: "original" });
    const original = client.promptAndWait("FIRST", { timeoutMs: 15000 });
    await waitRequest(1);
    await carryProviderRequestOptions(client, { ...selection, requestId: "steer-one" });
    await client.prompt("STEER_ONE", { streamingBehavior: "steer" });
    await carryProviderRequestOptions(client, { ...selection, requestId: "steer-two" });
    await client.prompt("STEER_TWO", { streamingBehavior: "steer" });
    release();
    assert.equal(assistant(await original)?.stopReason, "stop");
    assert.ok(requests.length >= 2);
    let count = requests.length;
    assert.equal(
      assistant(await client.promptAndWait("INDEPENDENT_UNPREPARED", { timeoutMs: 15000 }))
        ?.stopReason,
      "error",
    );
    assert.equal(requests.length, count);
    hold = true;
    await prepareProviderRequestOptions(client, { ...selection, requestId: "race-original" });
    const first = client.promptAndWait("RACE_FIRST", { timeoutMs: 15000 });
    await waitRequest(count + 1);
    await carryProviderRequestOptions(client, { ...selection, requestId: "race-append" });
    release();
    assert.equal(assistant(await first)?.stopReason, "stop");
    assert.equal(
      assistant(
        await client.promptAndWait("AFTER_IDLE", { streamingBehavior: "steer", timeoutMs: 15000 }),
      )?.stopReason,
      "stop",
    );
    count = requests.length;
    assert.equal(
      assistant(await client.promptAndWait("NEW_UNPREPARED", { timeoutMs: 15000 }))?.stopReason,
      "error",
    );
    assert.equal(requests.length, count);
    for (const request of requests) assert.equal(request.fixture_map, "low");
  },
);
