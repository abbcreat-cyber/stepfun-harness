import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelSelectionView } from "@zcode/provider";
import { writeStepDesktopCredential, readStepConnectionKey } from "../src/model-provider/stepCommunityApiKey.js";
import { wrapModelSelectionServiceForStepCommunity, createStepCommunityService } from "../src/model-provider/stepCommunityModelSelectionRuntime.js";
import { buildStepCommunityCliConnections } from "../src/model-provider/stepCommunityCliConnections.js";
import { syncCustomProvidersToStepCliModelsFile } from "../src/model-provider/cliProviderSync.js";

test("双连接同时投影、独立路由并复用 CLI 同步，选择订阅也查询 API 余额", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-dual-"));
  const env = { STEP_BACKEND: "stepcode-local", STEPCODE_DESKTOP_CREDENTIALS: join(root, "keys.json"), STEPCODE_AUTH_PATH: join(root, "no-auth.json") };
  const fetchBefore = globalThis.fetch;
  try {
    await writeStepDesktopCredential(env, "api-fixture", "api");
    await writeStepDesktopCredential(env, "plan-fixture", "subscription");
    const baseView: ModelSelectionView = { revision: 1, providers: [] };
    const modelSelection = wrapModelSelectionServiceForStepCommunity({
      getView: async () => baseView, onDidChange: () => ({ dispose() {} }),
    }, { env });
    const view = await modelSelection.getView();
    const visible = view.providers.filter(p => p.config.visibility !== "hidden");
    assert.deepEqual(visible.map(p => p.providerId), ["step-api", "step-plan"]);
    assert.equal(view.preferredSelection?.providerId, "step-plan");
    assert.ok(!JSON.stringify(view).includes("fixture"), "模型视图不得含密钥");
    for (const providerId of ["step-api", "step-plan"]) {
      const selected = await modelSelection.getView({ selection: { providerId, modelId: "step-5-preview", options: { reasoningLevel: "enabled" } } });
      assert.equal(selected.effectiveSelection?.providerId, providerId);
      assert.equal(selected.selectionIssue, undefined);
    }
    const entries = buildStepCommunityCliConnections(env, view);
    assert.deepEqual(entries.map(p => [p.providerId, p.baseUrl, p.apiKey]), [
      ["step-api", "https://api.stepfun.com/v1", "api-fixture"],
      ["step-plan", "https://api.stepfun.com/step_plan/v1", "plan-fixture"],
    ]);
    const path = join(root, "models.json");
    await syncCustomProvidersToStepCliModelsFile(env, entries, { modelsFilePath: path });
    const stored = JSON.parse(await readFile(path, "utf8"));
    assert.equal(stored.providers["step-plan"].apiKey, "plan-fixture");
    assert.equal(stored.providers["step-api"].models[0].contextWindow, 256000);
    let authorization: string | undefined;
    globalThis.fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(JSON.stringify({ balance: 0 }), { status: 200 });
    };
    const service = createStepCommunityService({ env, modelSelection });
    assert.equal((await service.getAccountBalance()).balance, 0);
    assert.equal(authorization, "Bearer api-fixture");
    await writeStepDesktopCredential(env, "new-api-fixture", "api", { activate: false });
    assert.equal(readStepConnectionKey(env, "subscription").key, "plan-fixture");
    assert.equal((await service.getStatus()).connectionMode, "subscription");
  } finally { globalThis.fetch = fetchBefore; await rm(root, { recursive: true, force: true }); }
});
