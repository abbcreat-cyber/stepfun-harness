import assert from "node:assert/strict";
import { join } from "node:path";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { createClientRuntime } from "../src/bridge/client-runtime.mjs";
import { createStepWorkflowDriver } from "../src/workflow/step-driver.mjs";

export async function verifyNativeActorEnvironment(fixture, http) {
  const ctx = {
    options: {
      stepEnv: {
        ...fixture.env,
        STEP_BACKEND: "stepcode-local",
        STEPCODE_STORAGE_ROOT_DIR: join(fixture.root, "actor-storage"),
      },
    },
    STATE_DIR: fixture.root,
  };
  const environment = createClientRuntime(ctx).clientEnvironment;
  const start = StepCodeRpcClient.prototype.start;
  let actorClient;
  StepCodeRpcClient.prototype.start = async function () {
    await start.call(this);
    actorClient = this;
  };
  const driver = createStepWorkflowDriver(
    {
      command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions"],
      communicationMode: "required",
      cwd: fixture.root,
      model: { providerId: fixture.providerId, modelId: fixture.modelId },
      getClientEnvironment: environment,
      actorRoot: join(fixture.root, "actor-state"),
      runId: "native-actor",
      conversationRoot: join(fixture.root, "actor-conversations"),
      parentSessionId: "fixture-own-session",
      journal: { getActor: () => ({ name: "fixture" }) },
    },
    {},
  );
  try {
    await driver.createActorSession({ siteId: "actor", ordinal: 0 }, {});
    assert.equal(actorClient.options.env.STEP_DISABLE_CRON, "1");
    assert.equal(actorClient.options.env.STEPCODE_TASK_MODE, undefined);
    http.requests.length = 0;
    http.set({ kind: "text", text: "ACTOR_NO_NATIVE_CRON" });
    await actorClient.promptAndWait("Inspect isolated actor tools", { timeoutMs: 20000 });
    const tools = http.requests[0].body.tools.map((tool) => (tool.function ?? tool).name);
    assert.ok(["cron_create", "cron_list", "cron_delete"].every((name) => !tools.includes(name)));
    return {
      actualActor: true,
      nativeCronDisabled: true,
      desktopRelayClaimed: false,
      toolNames: tools,
    };
  } finally {
    StepCodeRpcClient.prototype.start = start;
    driver.dispose();
    await driver.closed;
  }
}
