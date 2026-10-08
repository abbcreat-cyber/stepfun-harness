import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import {
  requiresProviderCommunication,
  withProviderCommunication,
} from "../src/provider-communication.mjs";
import { httpFixture, protocols, assistant } from "./provider-wire-fixtures.mjs";

test("RPC backend mode is required by default; explicit mock cannot downgrade a production Host", () => {
  assert.equal(
    requiresProviderCommunication({ command: ["unknown-renamed.exe", "--mode", "rpc"] }),
    true,
  );
  assert.equal(requiresProviderCommunication({ communicationMode: "mock" }), false);
  assert.equal(
    requiresProviderCommunication({
      communicationMode: "mock",
      env: { STEP_BACKEND: "stepcode-local" },
    }),
    true,
  );
  assert.throws(() => requiresProviderCommunication({ communicationMode: "disabled" }), /Invalid/);
  assert.ok(withProviderCommunication(["npm", "run", "native-rpc"]).includes("--extension"));
});

test(
  "renamed installed Step and Node wrapper require the trusted component",
  {
    skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI; same-SHA real Step required",
    timeout: 60000,
  },
  async (t) => {
    const rootBase = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-command-tests";
    await mkdir(rootBase, { recursive: true });
    const root = await mkdtemp(join(rootBase, "backend-"));
    await mkdir(join(root, "agent"));
    const original = process.env.STEP_TEST_CLI,
      renamed = join(root, "trusted-runtime-renamed.exe"),
      wrapper = join(root, "rpc-wrapper.mjs");
    await copyFile(original, renamed);
    await cp(join(dirname(original), "theme"), join(root, "theme"), { recursive: true });
    const sha = (data) => createHash("sha256").update(data).digest("hex");
    assert.equal(sha(await readFile(original)), sha(await readFile(renamed)));
    await writeFile(
      wrapper,
      `import {spawnSync} from "node:child_process";const result=spawnSync(${JSON.stringify(renamed)},process.argv.slice(2),{stdio:"inherit",windowsHide:true});process.exit(result.status??1);`,
    );
    const http = await httpFixture(protocols[0]);
    t.after(() => http.close());
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          "command-fixture": {
            api: "openai-completions",
            baseUrl: http.baseUrl,
            apiKey: "__stepcode_internal_auth_gate__",
            authHeader: false,
            models: [
              {
                id: "command-model",
                reasoning: false,
                contextWindow: 32768,
                maxTokens: 1024,
                compat: {
                  stepcodeDesktop: {
                    version: 1,
                    providerId: "command-fixture",
                    modelId: "command-model",
                    protocol: "openai-completions",
                    apiRoot: http.baseUrl,
                    authMode: "none",
                    supportsToolCall: false,
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
    const cases = [];
    t.after(async () => {
      if (process.env.STEP_WIRE_EVIDENCE_DIR) {
        await mkdir(process.env.STEP_WIRE_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          join(process.env.STEP_WIRE_EVIDENCE_DIR, "command-boundary.json"),
          JSON.stringify(
            { original, renamedSha: sha(await readFile(renamed)), cases, requests: http.requests },
            null,
            2,
          ),
        );
      }
      await rm(root, { recursive: true, force: true });
    });
    for (const [name, prefix] of [
      ["same-SHA renamed executable", [renamed]],
      ["Node wrapper", [process.execPath, wrapper]],
    ])
      await t.test(name, async () => {
        const client = new StepCodeRpcClient({
          command: [...prefix, "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions"],
          cwd: root,
          env,
          requestTimeoutMs: 15000,
        });
        try {
          await client.start();
          await client.setModel("command-fixture", "command-model");
          await client.request({ type: "set_auto_retry", enabled: false });
          const events = await client.promptAndWait("RENAMED_TEXT", { timeoutMs: 15000 });
          assert.equal(assistant(events)?.stopReason, "stop", assistant(events)?.errorMessage);
          const request = http.requests.at(-1);
          assert.ok(
            !Object.values(request.headers).some((value) =>
              String(value).includes("__stepcode_internal_auth_gate__"),
            ),
          );
          assert.ok(!("authorization" in request.headers));
          assert.ok(client.resolveSpawnCommand().args.includes("--extension"));
          cases.push({ name, passed: true });
        } catch (error) {
          cases.push({ name, passed: false, error: error.message });
          throw error;
        } finally {
          await client.stop();
        }
      });
    await t.test(
      "wrapper dropping the trusted component fails startup before model HTTP",
      async () => {
        const droppingWrapper = join(root, "rpc-wrapper-dropping.mjs");
        await writeFile(
          droppingWrapper,
          `import {spawnSync} from "node:child_process";const args=process.argv.slice(2);for(let i=args.length-1;i>=0;i--)if(args[i]==="--extension")args.splice(i,2);const result=spawnSync(${JSON.stringify(renamed)},args,{stdio:"inherit",windowsHide:true});process.exit(result.status??1);`,
        );
        const client = new StepCodeRpcClient({
          command: [
            process.execPath,
            droppingWrapper,
            "--mode",
            "rpc",
            "--no-session",
            "--no-tools",
            "--no-extensions",
          ],
          cwd: root,
          env,
          requestTimeoutMs: 15000,
        });
        const count = http.requests.length;
        await assert.rejects(client.start(), /communication extension failed to initialize/);
        assert.equal(http.requests.length, count);
        assert.equal(client.isRunning(), false);
        cases.push({ name: "missing trusted component", passed: true, requests: 0 });
      },
    );
  },
);
