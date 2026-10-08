import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveStepConfigPaths } from "@zcode/shared/node";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  ModelConfig,
  parseProviderConfig,
  ProviderConfigMap,
} from "@zcode/provider";
import { createStepCommunityModelConfig } from "../src/model-provider/stepCommunityModelSelection.ts";
import {
  buildCliSyncProviders,
  buildCliSyncProvidersFromSnapshot,
  createStepCliProviderSyncSink,
  syncCustomProvidersToStepCliModelsFile,
  type StepCliRegistryProviderViewLike,
} from "../src/model-provider/cliProviderSync.ts";

function view(apiKey = "sk-fixture-unknown-1"): StepCliRegistryProviderViewLike {
  return {
    providerId: "unknown-vendor",
    config: {
      access: { type: "api-key", apiKey },
      api: {
        type: "openai-chat-completions",
        baseUrl: "http://localhost:1234/v1",
        headers: { "X-Fixture": "provider" },
        compat: { supportsStore: false },
      },
    },
    models: [
      {
        modelId: "unknown-model",
        config: {
          properties: { contextWindow: 32768, inputFormat: { supportsImage: true } },
          optionSpecs: {
            reasoningLevel: { values: ["disabled"], map: "{}" },
            maxOutputTokens: { max: 4096, map: "{}" },
          },
          native: {
            reasoning: false,
            headers: { "X-Model": "fixture" },
            compat: { supportsDeveloperRole: false },
            thinkingLevelMap: { low: "lite", high: "deep" },
            samplingParams: { temperature: 0.3 },
          },
        },
      },
    ],
  };
}

async function fixture(run: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "step-reconcile-"));
  try {
    await run(join(root, "models.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("完整投影无品牌分支：headers、限制和显式 native 参数保留", async () => {
  const plan = buildCliSyncProviders(["unknown-vendor"], [view()]);
  await fixture(async (modelsFilePath) => {
    await syncCustomProvidersToStepCliModelsFile({}, plan.providers, { modelsFilePath });
    const result = JSON.parse(await readFile(modelsFilePath, "utf8"));
    assert.deepEqual(result.providers["unknown-vendor"], {
      api: "openai-completions",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "sk-fixture-unknown-1",
      headers: { "X-Fixture": "provider" },
      compat: { supportsStore: false },
      models: [
        {
          id: "unknown-model",
          input: ["text", "image"],
          contextWindow: 32768,
          maxTokens: 4096,
          reasoning: false,
          headers: { "X-Model": "fixture" },
          compat: {
            supportsDeveloperRole: false,
            stepcodeDesktop: {
              version: 1,
              providerId: "unknown-vendor",
              modelId: "unknown-model",
              protocol: "openai-completions",
              apiRoot: "http://localhost:1234/v1",
              authMode: "api-key",
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: { max: 4096, map: "{}" },
              },
            },
          },
          thinkingLevelMap: { low: "lite", high: "deep" },
          samplingParams: { temperature: 0.3 },
        },
      ],
    });
    assert.equal(result._stepcodeDesktopProviders.version, 1);
    assert.match(
      result._stepcodeDesktopProviders.providers["unknown-vendor"].hash,
      /^[a-f0-9]{64}$/,
    );
  });
});

test("生产入口只投影同一已提交Registry snapshot的personal IDs和配置", () => {
  const provider = parseProviderConfig({
    group: "standard-personal",
    access: { type: "api-key", apiKey: "sk-fixture-snapshot" },
    api: {
      type: "openai-responses",
      baseUrl: "http://localhost:1234/v1",
      headers: { "X-Revision": "committed" },
    },
  });
  const completeProvider = createRegistryProviderConfig(provider);
  const completeModel = createRegistryModelConfig(
    ModelConfig.fromData(createStepCommunityModelConfig()),
  );
  assert.equal(completeProvider.ok, true);
  assert.equal(completeModel.ok, true);
  if (!completeProvider.ok || !completeModel.ok) throw new Error("invalid fixture");
  const config = { personalProviders: new ProviderConfigMap([["unknown-vendor", provider]]) };
  const registry = {
    revision: 7,
    providers: [
      {
        providerId: "unknown-vendor",
        config: completeProvider.config,
        models: [{ modelId: "unknown-model", config: completeModel.config }],
      },
    ],
  };
  const result = buildCliSyncProvidersFromSnapshot({ config, registry });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.providers[0]?.headers?.["X-Revision"], "committed");
  assert.equal(result.providers[0]?.models[0]?.contextWindow, 256000);
  assert.deepEqual(
    buildCliSyncProvidersFromSnapshot({
      config: { personalProviders: ProviderConfigMap.empty() },
      registry,
    }).providers,
    [],
  );
});

test("显式none/headers使用独立门控且metadata不复制真实认证材料", () => {
  for (const authMode of ["none", "headers"] as const) {
    const fixture = view();
    const withMode = {
      ...fixture,
      config: {
        ...fixture.config,
        access: { type: "api-key", apiKey: "" },
        api: {
          ...fixture.config.api,
          authMode,
          headers: { Authorization: "Fixture header secret" },
        },
      },
    };
    const plan = buildCliSyncProviders(["unknown-vendor"], [withMode]);
    assert.deepEqual(plan.skipped, []);
    assert.equal(plan.providers[0]?.apiKey, "__stepcode_internal_auth_gate__");
    assert.equal(plan.providers[0]?.authHeader, false);
    const metadata = plan.providers[0]?.models[0]?.compat?.stepcodeDesktop;
    assert.equal(JSON.stringify(metadata).includes("Fixture header secret"), false);
    assert.equal(JSON.stringify(metadata).includes("__stepcode_internal_auth_gate__"), false);
  }
});

test("删除、禁用、清空最后一个key都会协调空desired，保留非owned项", async () => {
  for (const ids of [[], ["unknown-vendor"]])
    await fixture(async (modelsFilePath) => {
      const initial = buildCliSyncProviders(["unknown-vendor"], [view()]);
      await syncCustomProvidersToStepCliModelsFile({}, initial.providers, { modelsFilePath });
      const current = JSON.parse(await readFile(modelsFilePath, "utf8"));
      current.providers.manual = { models: [{ id: "manual" }] };
      await writeFile(modelsFilePath, JSON.stringify(current));
      const plan = buildCliSyncProviders(ids, ids.length ? [view("")] : []);
      await syncCustomProvidersToStepCliModelsFile({}, plan.providers, { modelsFilePath });
      const next = JSON.parse(await readFile(modelsFilePath, "utf8"));
      assert.deepEqual(next.providers, { manual: current.providers.manual });
      assert.deepEqual(next._stepcodeDesktopProviders.providers, {});
    });
});

test("手写同id冲突、owned手改、损坏metadata均原子失败且不输出key", async () => {
  await fixture(async (modelsFilePath) => {
    const desired = buildCliSyncProviders(["unknown-vendor"], [view()]).providers;
    const manual = { providers: { "unknown-vendor": { models: [{ id: "manual" }] } } };
    const original = JSON.stringify(manual);
    await writeFile(modelsFilePath, original);
    await assert.rejects(
      syncCustomProvidersToStepCliModelsFile({}, desired, { modelsFilePath }),
      /冲突/,
    );
    assert.equal(await readFile(modelsFilePath, "utf8"), original);
    await writeFile(modelsFilePath, "{}");
    await syncCustomProvidersToStepCliModelsFile({}, desired, { modelsFilePath });
    const managed = JSON.parse(await readFile(modelsFilePath, "utf8"));
    managed.providers["unknown-vendor"].apiKey = "sk-fixture-manual-edit";
    const edited = JSON.stringify(managed);
    await writeFile(modelsFilePath, edited);
    await assert.rejects(
      syncCustomProvidersToStepCliModelsFile({}, [], { modelsFilePath }),
      /冲突/,
    );
    assert.equal(await readFile(modelsFilePath, "utf8"), edited);
    managed._stepcodeDesktopProviders.version = 99;
    const corrupt = JSON.stringify(managed);
    await writeFile(modelsFilePath, corrupt);
    await assert.rejects(
      syncCustomProvidersToStepCliModelsFile({}, [], { modelsFilePath }),
      /ownership/,
    );
    assert.equal(await readFile(modelsFilePath, "utf8"), corrupt);
  });
});

test("旧无metadata仅能接管完全匹配的当前投影，不能猜删不再desired的旧项", async () => {
  await fixture(async (modelsFilePath) => {
    const desired = buildCliSyncProviders(["unknown-vendor"], [view()]).providers;
    await syncCustomProvidersToStepCliModelsFile({}, desired, { modelsFilePath });
    const document = JSON.parse(await readFile(modelsFilePath, "utf8"));
    delete document._stepcodeDesktopProviders;
    document.providers.legacyUnknown = { apiKey: "sk-fixture-legacy", models: [] };
    await writeFile(modelsFilePath, JSON.stringify(document));
    await syncCustomProvidersToStepCliModelsFile({}, desired, { modelsFilePath });
    await syncCustomProvidersToStepCliModelsFile({}, [], { modelsFilePath });
    assert.deepEqual(JSON.parse(await readFile(modelsFilePath, "utf8")).providers, {
      legacyUnknown: document.providers.legacyUnknown,
    });
  });
});

test("严格R45投影首次升级可以补完整字段，未知manual.extra或值变化仍冲突", async () => {
  await fixture(async (modelsFilePath) => {
    const desired = buildCliSyncProviders(["unknown-vendor"], [view()]).providers;
    const legacy = {
      api: "openai-completions",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "sk-fixture-unknown-1",
      models: [{ id: "unknown-model", input: ["text", "image"] }],
    };
    const original = { providers: { "unknown-vendor": legacy } };
    await writeFile(modelsFilePath, JSON.stringify(original));
    await syncCustomProvidersToStepCliModelsFile({}, desired, { modelsFilePath });
    const next = JSON.parse(await readFile(modelsFilePath, "utf8"));
    assert.deepEqual(next.providers["unknown-vendor"].headers, { "X-Fixture": "provider" });
    assert.equal(next.providers["unknown-vendor"].models[0].contextWindow, 32768);
    assert.ok(next._stepcodeDesktopProviders.providers["unknown-vendor"]);
    for (const manual of [
      { ...legacy, extra: "manual" },
      { ...legacy, apiKey: "sk-fixture-old-or-manual-key" },
      { ...legacy, models: [{ ...legacy.models[0], extra: "manual" }] },
    ]) {
      const content = JSON.stringify({ providers: { "unknown-vendor": manual } });
      await writeFile(modelsFilePath, content);
      await assert.rejects(
        syncCustomProvidersToStepCliModelsFile({}, desired, { modelsFilePath }),
        /冲突/,
      );
      assert.equal(await readFile(modelsFilePath, "utf8"), content);
    }
  });
});

test("owned项被手工删除或unknown metadata形状损坏不能悄悄重建或删除其他项", async () => {
  await fixture(async (modelsFilePath) => {
    const desired = buildCliSyncProviders(["unknown-vendor"], [view()]).providers;
    await syncCustomProvidersToStepCliModelsFile({}, desired, { modelsFilePath });
    const document = JSON.parse(await readFile(modelsFilePath, "utf8"));
    delete document.providers["unknown-vendor"];
    const missing = JSON.stringify(document);
    await writeFile(modelsFilePath, missing);
    await assert.rejects(
      syncCustomProvidersToStepCliModelsFile({}, desired, { modelsFilePath }),
      /冲突/,
    );
    assert.equal(await readFile(modelsFilePath, "utf8"), missing);
    document._stepcodeDesktopProviders.providers = { invalid: { hash: "broken" } };
    const corrupt = JSON.stringify(document);
    await writeFile(modelsFilePath, corrupt);
    await assert.rejects(
      syncCustomProvidersToStepCliModelsFile({}, [], { modelsFilePath }),
      /ownership/,
    );
    assert.equal(await readFile(modelsFilePath, "utf8"), corrupt);
  });
});

test("latest generation sink串行完整snapshot，快速保存跳过待处理旧代并等待最新成功", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed: number[] = [];
  let concurrent = 0;
  const sink = createStepCliProviderSyncSink(
    async (snapshot: { revision: number; ids: string[]; models: string[] }) => {
      assert.equal(++concurrent, 1);
      assert.deepEqual(snapshot.ids, snapshot.models);
      if (snapshot.revision === 1) await barrier;
      committed.push(snapshot.revision);
      concurrent--;
    },
  );
  const one = sink.sync({ revision: 1, ids: ["one"], models: ["one"] });
  const two = sink.sync({ revision: 2, ids: ["two"], models: ["two"] });
  const three = sink.sync({ revision: 3, ids: ["three"], models: ["three"] });
  release();
  await Promise.all([one, two, three, sink.wait()]);
  assert.deepEqual(committed, [1, 3]);
});

test("sink失败传播给spawn等待者，后续有效快照可以恢复", async () => {
  const sink = createStepCliProviderSyncSink(async (snapshot: number) => {
    if (snapshot === 1) throw new Error("fixture writer failed");
  });
  await assert.rejects(sink.sync(1), /fixture writer failed/);
  await assert.rejects(sink.wait(), /fixture writer failed/);
  await sink.sync(2);
  await sink.wait();
});

test("较旧refresh回调晚到不能覆盖较新提交snapshot", async () => {
  const written: number[] = [];
  const sink = createStepCliProviderSyncSink(
    async (revision: number) => {
      written.push(revision);
    },
    { getRevision: (revision) => revision },
  );
  await sink.sync(3);
  const sync = sink.sync;
  await sync(1);
  await sink.wait();
  assert.deepEqual(written, [3]);
});

test("多workspace并发写入同一完整desired，不丢手写项或所有权", async () => {
  await fixture(async (modelsFilePath) => {
    await writeFile(
      modelsFilePath,
      JSON.stringify({ providers: { manual: { models: [{ id: "manual" }] } } }),
    );
    const plan = buildCliSyncProviders(["unknown-vendor"], [view()]);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        syncCustomProvidersToStepCliModelsFile({}, plan.providers, { modelsFilePath }),
      ),
    );
    const result = JSON.parse(await readFile(modelsFilePath, "utf8"));
    assert.deepEqual(Object.keys(result.providers).sort(), ["manual", "unknown-vendor"]);
    assert.deepEqual(Object.keys(result._stepcodeDesktopProviders.providers), ["unknown-vendor"]);
  });
});

test("公共Step路径：绝对root、相对root、HOME/USERPROFILE及显式agentDir一致", () => {
  const home = resolve("fixture-home");
  const absolute = resolve("fixture-absolute-root");
  assert.deepEqual(resolveStepConfigPaths({ HOME: home, STEPCODE_CONFIG_DIR: absolute }), {
    root: absolute,
    agentDir: join(absolute, "agent"),
    modelsFile: join(absolute, "models.json"),
  });
  assert.equal(
    resolveStepConfigPaths({ USERPROFILE: home, STEPCODE_CONFIG_DIR: "relative" }).root,
    join(home, "relative"),
  );
  assert.equal(
    resolveStepConfigPaths({
      HOME: home,
      STEPCODE_CONFIG_DIR: absolute,
      STEP_CODING_AGENT_DIR: join(home, "explicit", "agent"),
    }).root,
    join(home, "explicit"),
  );
});
