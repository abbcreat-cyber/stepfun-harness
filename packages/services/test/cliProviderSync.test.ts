/**
 * cliProviderSync 单元测试：个人供应商凭据 → Step CLI models.json 的同步原语。
 *
 * 凭据纪律（规矩 3）：生产机制里 Key 只允许从桌面凭据存储流向 step CLI 自己的
 * 凭据文件（models.json）。本测试一律使用 fixture 假 Key（sk-fixture-* 前缀），
 * 绝不写入、断言或输出任何真实凭据。
 *
 * 跑法：packages/services 下 `npx tsx --test test/cliProviderSync.test.ts`
 * （源码 import 使用 .js specifier，裸 node --test 无法解析 TS→ESM 映射，
 * 与同目录既有测试一致——stepCommunityConnections.test.ts 同样需要 tsx）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireFileLock } from "@zcode/shared/node";

import {
  buildCliSyncProviders,
  resolveStepModelsFilePath,
  syncCustomProvidersToStepCliModelsFile,
  type StepCliRegistryProviderViewLike,
} from "../src/model-provider/cliProviderSync.ts";

/** fixture 假 Key（绝不使用真实凭据）。 */
const DEEPSEEK_FIXTURE_KEY = "sk-fixture-deepseek-1";
const OPENAI_FIXTURE_KEY = "sk-fixture-openai-1";
const ROTATED_FIXTURE_KEY = "sk-fixture-deepseek-2-rotated";

/**
 * registry view 投影 fixture：DeepSeek 个人供应商（anthropic 方言，/anthropic 端点原样透传）。
 * 模型能力投影模拟真实运行时形状（facades.ts:583 config: serializeRegistryModelConfig）：
 * deepseek-flash 带视觉依据（properties.inputFormat.supportsImage=true——UI「视觉」
 * 徽章同款字段，用户真机配置的运行时元数据）；deepseek-v4-pro 无视觉依据（false）。
 */
function deepseekView(apiKey: string = DEEPSEEK_FIXTURE_KEY): StepCliRegistryProviderViewLike {
  return {
    providerId: "deepseek",
    config: {
      access: { type: "api-key", apiKey },
      api: { type: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
    },
    models: [
      {
        modelId: "deepseek-flash",
        config: { properties: { inputFormat: { supportsImage: true } } },
      },
      {
        modelId: "deepseek-v4-pro",
        config: { properties: { inputFormat: { supportsImage: false } } },
      },
    ],
  };
}

/** registry view 投影 fixture：OpenAI 兼容个人供应商（桌面方言名带 chat-，需翻译成 CLI 名）。 */
function openaiCompatibleView(): StepCliRegistryProviderViewLike {
  return {
    providerId: "my-openai-proxy",
    config: {
      access: { type: "api-key", apiKey: OPENAI_FIXTURE_KEY },
      api: { type: "openai-chat-completions", baseUrl: "https://api.example-proxy.com/v1" },
    },
    models: [
      { modelId: "gpt-test-1" },
      { modelId: "gpt-test-1" },
      { modelId: "" },
    ],
  };
}

/** registry view 投影 fixture：openai-responses 方言个人供应商（两侧枚举名相同，直通）。 */
function responsesDialectView(): StepCliRegistryProviderViewLike {
  return {
    providerId: "my-responses-provider",
    config: {
      access: { type: "api-key", apiKey: OPENAI_FIXTURE_KEY },
      api: { type: "openai-responses", baseUrl: "https://api.example-responses.com/v1" },
    },
    models: [{ modelId: "resp-test-1" }],
  };
}

test("buildCliSyncProviders：个人规则 ∩ registry 视图产出 CLI 原生条目（含 api 方言名翻译）", () => {
  const plan = buildCliSyncProviders(
    ["deepseek", "my-openai-proxy", "not-in-view-provider"],
    [deepseekView(), openaiCompatibleView()],
  );

  assert.equal(plan.providers.length, 2, `应产出两条 provider，实际 ${JSON.stringify(plan.providers.map((p) => p.providerId))}`);

  const deepseek = plan.providers.find((p) => p.providerId === "deepseek");
  assert.ok(deepseek, "必须包含 deepseek 条目");
  assert.equal(deepseek.api, "anthropic-messages", "anthropic-messages 方言名两侧一致，原样透传");
  assert.equal(deepseek.baseUrl, "https://api.deepseek.com/anthropic", "baseUrl 原样透传（CLI 自行剥尾部 /v1 或 /messages，桌面不归一化）");
  assert.equal(deepseek.apiKey, DEEPSEEK_FIXTURE_KEY, "apiKey 为桌面凭据原值（仅用于写盘，机制本身）");
  assert.deepEqual(
    deepseek.models,
    [
      { modelId: "deepseek-flash", supportsImage: true },
      { modelId: "deepseek-v4-pro", supportsImage: false },
    ],
    "模型清单来自 registry 视图（含 supportsImage 能力投影：flash 有视觉依据标 true，v4-pro 无依据如实 false）",
  );

  const openai = plan.providers.find((p) => p.providerId === "my-openai-proxy");
  assert.ok(openai, "必须包含 my-openai-proxy 条目");
  assert.equal(openai.api, "openai-completions", "桌面方言名 openai-chat-completions 必须翻译为 CLI 的 openai-completions（两侧枚举名不同）");
  assert.equal(openai.baseUrl, "https://api.example-proxy.com/v1", "openai 兼容端点 /v1 原样保留（CLI openai 方言自补操作段）");
  assert.deepEqual(
    openai.models,
    [{ modelId: "gpt-test-1", supportsImage: false }],
    "模型清单去重保序；视图模型条目缺失能力元数据（无 config）时保守 supportsImage=false（不瞎标）",
  );

  assert.deepEqual(
    plan.skipped,
    [{ providerId: "not-in-view-provider", reason: "not-in-registry-view" }],
    "个人规则里不在 registry 视图的条目如实回报 skipped",
  );
});

test("buildCliSyncProviders：openai-responses 两侧枚举名相同直通产出（R5 low⑭，mock 验证后放开）", () => {
  const plan = buildCliSyncProviders(["my-responses-provider"], [responsesDialectView()]);
  assert.deepEqual(plan.skipped, [], "同名方言不再进 skipped");
  assert.equal(plan.providers.length, 1);
  assert.equal(plan.providers[0]!.api, "openai-responses", "CLI 侧 KnownApi 原生含同名方言，直通不翻译");
});

test("buildCliSyncProviders：视觉元数据映射——视图 supportsImage=true 才标图片输入，唯一依据是 registry 视图投影", () => {
  // 用户真机场景（R6 根因）：deepseek-flash 在桌面侧带视觉元数据（UI 选择器「视觉」
  // 标签的数据源=config.properties.inputFormat.supportsImage=true），同步必须携带，
  // 否则 CLI 端 input 缺省默认 ["text"]（provider-composer.ts:166），图片被替换为
  // 英文占位文本（read.ts:96），模型如实转述「看不到图」。
  const plan = buildCliSyncProviders(["deepseek"], [deepseekView()]);
  const deepseek = plan.providers.find((p) => p.providerId === "deepseek");
  assert.ok(deepseek, "前置：deepseek 条目已产出");
  const flash = deepseek.models.find((m) => m.modelId === "deepseek-flash");
  assert.ok(flash, "前置：deepseek-flash 在模型清单中");
  assert.equal(flash.supportsImage, true, "有视觉依据的模型（视图 supportsImage=true）如实标 true");
  const v4Pro = deepseek.models.find((m) => m.modelId === "deepseek-v4-pro");
  assert.ok(v4Pro, "前置：deepseek-v4-pro 在模型清单中");
  assert.equal(v4Pro.supportsImage, false, "无视觉依据的模型如实标 false（保守 text-only，绝不盲目 vision:true）");
});

test("buildCliSyncProviders：未知模型不误标——supportsImage 非 true 的任何形态（false/undefined/null/config 缺失）一律保守 text-only", () => {
  const unknownModelsProvider: StepCliRegistryProviderViewLike = {
    providerId: "unknown-models-provider",
    config: {
      access: { type: "api-key", apiKey: OPENAI_FIXTURE_KEY },
      api: { type: "anthropic-messages", baseUrl: "https://api.example-proxy.com/anthropic" },
    },
    models: [
      // 五种「无视觉依据」形态：显式 false、null、undefined、config 缺 config、config 缺 properties。
      { modelId: "explicit-false-model", config: { properties: { inputFormat: { supportsImage: false } } } },
      { modelId: "explicit-null-model", config: { properties: { inputFormat: { supportsImage: null } } } },
      { modelId: "missing-field-model", config: { properties: { inputFormat: {} } } },
      { modelId: "missing-properties-model", config: {} },
      { modelId: "missing-config-model" },
      { modelId: "supports-text-only-model", config: { properties: { inputFormat: { supportsText: true, supportsImage: false } } } },
    ],
  };

  const plan = buildCliSyncProviders(["unknown-models-provider"], [unknownModelsProvider]);
  assert.equal(plan.providers.length, 1, "前置：provider 合格产出");
  assert.equal(plan.skipped.length, 0, "能力元数据缺失不是跳过条件（模型照常同步，只是保守 text-only）");
  const entry = plan.providers[0]!;
  for (const model of entry.models) {
    assert.equal(
      model.supportsImage,
      false,
      `模型 ${model.modelId} 无视觉依据时绝不误标（supportsImage 必须如实 false，CLI 端落 input:["text"]）`,
    );
  }
  assert.equal(entry.models.length, 6, "六种无依据形态全部保留在同步清单中");
});

test("buildCliSyncProviders：api 方言不在白名单 / 非 http(s) baseUrl / 空 apiKey / 非个人 Key 通道 → 跳过并回报 reason", () => {
  const unsupportedApi = {
    providerId: "cli-only-dialect-provider",
    config: {
      access: { type: "api-key", apiKey: OPENAI_FIXTURE_KEY },
      api: { type: "google-generative-ai", baseUrl: "https://api.example-proxy.com/v1" },
    },
    models: [{ modelId: "gpt-test-1" }],
  } satisfies StepCliRegistryProviderViewLike;

  const ftpBaseUrl = {
    providerId: "ftp-provider",
    config: {
      access: { type: "api-key", apiKey: OPENAI_FIXTURE_KEY },
      api: { type: "anthropic-messages", baseUrl: "ftp://example.com/anthropic" },
    },
    models: [{ modelId: "ftp-model-1" }],
  } satisfies StepCliRegistryProviderViewLike;

  const garbageBaseUrl = {
    providerId: "garbage-url-provider",
    config: {
      access: { type: "api-key", apiKey: OPENAI_FIXTURE_KEY },
      api: { type: "anthropic-messages", baseUrl: "not a url at all" },
    },
    models: [{ modelId: "garbage-model-1" }],
  } satisfies StepCliRegistryProviderViewLike;

  const missingBaseUrl = {
    providerId: "missing-base-url-provider",
    config: {
      access: { type: "api-key", apiKey: OPENAI_FIXTURE_KEY },
      api: { type: "anthropic-messages" },
    },
    models: [{ modelId: "missing-url-model-1" }],
  } satisfies StepCliRegistryProviderViewLike;

  const emptyApiKey = {
    providerId: "empty-key-provider",
    config: {
      access: { type: "api-key", apiKey: "   " },
      api: { type: "anthropic-messages", baseUrl: "https://api.example-proxy.com/anthropic" },
    },
    models: [{ modelId: "empty-key-model-1" }],
  } satisfies StepCliRegistryProviderViewLike;

  const zhipuCodingPlan = {
    providerId: "zhipu-coding-plan-provider",
    config: {
      access: { type: "zhipu-coding-plan-api-key", apiKey: OPENAI_FIXTURE_KEY },
      api: { type: "anthropic-messages", baseUrl: "https://api.example-proxy.com/anthropic" },
    },
    models: [{ modelId: "zhipu-model-1" }],
  } satisfies StepCliRegistryProviderViewLike;

  const noModels = {
    providerId: "no-models-provider",
    config: {
      access: { type: "api-key", apiKey: OPENAI_FIXTURE_KEY },
      api: { type: "anthropic-messages", baseUrl: "https://api.example-proxy.com/anthropic" },
    },
    models: [],
  } satisfies StepCliRegistryProviderViewLike;

  const plan = buildCliSyncProviders(
    [
      unsupportedApi.providerId,
      ftpBaseUrl.providerId,
      garbageBaseUrl.providerId,
      missingBaseUrl.providerId,
      emptyApiKey.providerId,
      zhipuCodingPlan.providerId,
      noModels.providerId,
    ],
    [unsupportedApi, ftpBaseUrl, garbageBaseUrl, missingBaseUrl, emptyApiKey, zhipuCodingPlan, noModels],
  );

  assert.deepEqual(plan.providers, [], "不满足条件的条目一律不产出");
  const skippedBy = new Map(plan.skipped.map((s) => [s.providerId, s.reason]));
  assert.equal(skippedBy.get("cli-only-dialect-provider"), "unsupported-api-type", "桌面枚举外的 CLI 方言名（如 google-generative-ai）仍在白名单外（诚实跳过，不瞎写）");
  assert.equal(skippedBy.get("ftp-provider"), "invalid-base-url", "非 http(s) 协议的 baseUrl 必须跳过");
  assert.equal(skippedBy.get("garbage-url-provider"), "invalid-base-url", "无法解析为 URL 的 baseUrl 必须跳过");
  assert.equal(skippedBy.get("missing-base-url-provider"), "invalid-base-url", "缺失 baseUrl 必须跳过");
  assert.equal(skippedBy.get("empty-key-provider"), "missing-api-key", "空白 apiKey 必须跳过（凭据门控）");
  assert.equal(skippedBy.get("zhipu-coding-plan-provider"), "unsupported-access-type", "智谱 Coding Plan 通道无 CLI BYOK 同步路径，诚实跳过");
  assert.equal(skippedBy.get("no-models-provider"), "no-models", "registry 视图模型清单为空的 provider 同步无意义，诚实跳过");
  assert.equal(plan.skipped.length, 7, "七类边界各自回报一条 skipped");
});

test("syncCustomProvidersToStepCliModelsFile：目标文件不存在时新建仅含同步条目（CLI 自定义供应商四件套）", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-cli-models-"));
  const modelsFilePath = join(root, "models.json");
  const env: Record<string, string | undefined> = { HOME: root };
  try {
    const result = await syncCustomProvidersToStepCliModelsFile(
      env,
      buildCliSyncProviders(["deepseek"], [deepseekView()]).providers,
      { modelsFilePath },
    );
    assert.equal(result.modelsFilePath, modelsFilePath);
    assert.deepEqual(result.syncedProviderIds, ["deepseek"]);

    const written = JSON.parse(await readFile(modelsFilePath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written), ["providers", "_stepcodeDesktopProviders"], "新文件包含 providers 和版本化 ownership");
    assert.deepEqual(
      (written.providers as Record<string, unknown>).deepseek,
      {
        api: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: DEEPSEEK_FIXTURE_KEY,
        models: [
          { id: "deepseek-flash", input: ["text", "image"], compat: { stepcodeDesktop: {
            version: 1, providerId: "deepseek", modelId: "deepseek-flash", protocol: "anthropic-messages",
            apiRoot: "https://api.deepseek.com/anthropic", authMode: "api-key",
          } } },
          { id: "deepseek-v4-pro", input: ["text"], compat: { stepcodeDesktop: {
            version: 1, providerId: "deepseek", modelId: "deepseek-v4-pro", protocol: "anthropic-messages",
            apiRoot: "https://api.deepseek.com/anthropic", authMode: "api-key",
          } } },
        ],
      },
      "条目形状=Step CLI models.json 原生自定义供应商四件套+模型能力字段（api/baseUrl/apiKey/models[].id+input；deepseek-flash 带图片输入能力，无视觉依据的 v4-pro 保守 text-only）",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncCustomProvidersToStepCliModelsFile：合并保留既有无关 provider 键（不覆盖用户手写条目）", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-cli-models-"));
  const modelsFilePath = join(root, "models.json");
  const env: Record<string, string | undefined> = { HOME: root };
  const userHandwritten = {
    providers: {
      ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "llama3.1:8b" }] },
    },
  };
  try {
    await writeFile(modelsFilePath, JSON.stringify(userHandwritten, null, 2), "utf8");
    await syncCustomProvidersToStepCliModelsFile(
      env,
      buildCliSyncProviders(["deepseek"], [deepseekView()]).providers,
      { modelsFilePath },
    );

    const merged = JSON.parse(await readFile(modelsFilePath, "utf8")) as {
      providers: Record<string, unknown>;
    };
    assert.deepEqual(
      merged.providers.ollama,
      userHandwritten.providers.ollama,
      "既有无关 provider 键必须逐字保留（CLI 对 models.json 只读不写，这是用户自己的配置层）",
    );
    assert.ok(merged.providers.deepseek, "本次同步条目已写入");
    assert.deepEqual(Object.keys(merged.providers).sort(), ["deepseek", "ollama"], "合并后包含既有键与本次键");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncCustomProvidersToStepCliModelsFile：畸形既有文件显式中文报错且绝不静默覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-cli-models-"));
  const modelsFilePath = join(root, "models.json");
  const env: Record<string, string | undefined> = { HOME: root };
  const malformedContent = "{oops not json";
  try {
    await writeFile(modelsFilePath, malformedContent, "utf8");
    await assert.rejects(
      syncCustomProvidersToStepCliModelsFile(
        env,
        buildCliSyncProviders(["deepseek"], [deepseekView()]).providers,
        { modelsFilePath },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error, "必须是 Error 实例");
        assert.ok(error.message.includes("已损坏"), `错误应显式说明文件已损坏，实际：${error.message}`);
        assert.ok(error.message.includes(modelsFilePath), `错误应带文件路径，实际：${error.message}`);
        return true;
      },
    );
    assert.equal(await readFile(modelsFilePath, "utf8"), malformedContent, "畸形文件必须原样保留（不覆盖、不备份重写）");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncCustomProvidersToStepCliModelsFile：重复同步=key 轮换幂等更新（只替换本次条目键）", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-cli-models-"));
  const modelsFilePath = join(root, "models.json");
  const env: Record<string, string | undefined> = { HOME: root };
  const userHandwritten = {
    providers: {
      ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "llama3.1:8b" }] },
    },
  };
  try {
    await writeFile(modelsFilePath, JSON.stringify(userHandwritten, null, 2), "utf8");
    await syncCustomProvidersToStepCliModelsFile(
      env,
      buildCliSyncProviders(["deepseek"], [deepseekView(DEEPSEEK_FIXTURE_KEY)]).providers,
      { modelsFilePath },
    );
    // 用户在桌面更换了 DeepSeek Key（新 fixture 假 Key），重新同步。
    await syncCustomProvidersToStepCliModelsFile(
      env,
      buildCliSyncProviders(["deepseek"], [deepseekView(ROTATED_FIXTURE_KEY)]).providers,
      { modelsFilePath },
    );

    const afterRotation = JSON.parse(await readFile(modelsFilePath, "utf8")) as {
      providers: Record<string, { apiKey: string; models: unknown[] }>;
    };
    assert.equal(afterRotation.providers.deepseek.apiKey, ROTATED_FIXTURE_KEY, "同 id 条目按最新 Key 覆盖（幂等更新）");
    assert.equal(afterRotation.providers.deepseek.models.length, 2, "模型清单随最新视图重写");
    assert.deepEqual(afterRotation.providers.ollama, userHandwritten.providers.ollama, "无关键在轮换中继续保留");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncCustomProvidersToStepCliModelsFile：空条目集仍协调，纯手写文件内容逐字不动", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-cli-models-"));
  const absentFilePath = join(root, "fresh-subdir", "models.json");
  const env: Record<string, string | undefined> = { HOME: root };
  const userHandwritten = JSON.stringify(
    {
      providers: {
        ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "llama3.1:8b" }] },
      },
    },
    null,
    2,
  );
  try {
    // 目标文件不存在时仍获取协作锁；无 owned 项便无需创建 models.json。
    const result = await syncCustomProvidersToStepCliModelsFile(env, [], { modelsFilePath: absentFilePath });
    assert.equal(result.modelsFilePath, absentFilePath, "返回值仍带权威路径（纯字符串解析，无盘操作）");
    assert.deepEqual(result.syncedProviderIds, [], "空条目集回报空清单");
    assert.ok(!existsSync(absentFilePath), "空条目集绝不写盘");
    assert.ok(existsSync(join(root, "fresh-subdir")), "空条目集也进入同一锁内协调路径");

    // 目标文件存在（用户手写条目）：空条目集不触碰，内容逐字节不变。
    const existingFilePath = join(root, "models.json");
    await writeFile(existingFilePath, userHandwritten, "utf8");
    await syncCustomProvidersToStepCliModelsFile(env, [], { modelsFilePath: existingFilePath });
    assert.equal(await readFile(existingFilePath, "utf8"), userHandwritten, "既有文件逐字节不动（骨架重写也不允许）");

    // 全部条目被跳过的真实计划（buildCliSyncProviders 产出空 providers）同样早退。
    const skippedOnlyPlan = buildCliSyncProviders(["not-in-view-provider"], [deepseekView()]);
    assert.equal(skippedOnlyPlan.providers.length, 0, "前置：该计划确实无合格条目");
    await syncCustomProvidersToStepCliModelsFile(env, skippedOnlyPlan.providers, { modelsFilePath: absentFilePath });
    assert.ok(!existsSync(absentFilePath), "全跳过计划同样不写盘");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncCustomProvidersToStepCliModelsFile：读-合并-写全程持锁——锁内窗口外部提交的键不丢（R5 low⑬）", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-cli-models-"));
  const modelsFilePath = join(root, "models.json");
  const env: Record<string, string | undefined> = { HOME: root };
  const baseline = {
    providers: {
      ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "llama3.1:8b" }] },
    },
  };
  const externallyCommitted = {
    providers: {
      ...baseline.providers,
      "external-probe": { baseUrl: "https://api.external.example/v1", api: "openai-completions", apiKey: "sk-fixture-external-1", models: [{ id: "external-model-1" }] },
    },
  };
  try {
    await writeFile(modelsFilePath, JSON.stringify(baseline, null, 2), "utf8");
    // 测试侧先持同一把协作锁（模拟另一 Host 正在写 models.json），随后启动同步：
    // 新实现的读段发生在拿到锁之后；旧实现（读段在锁外）会在等待前读完旧基线。
    const releaseExternalLock = await acquireFileLock(modelsFilePath, [25, 50, 100, 200, 400], 100, 8_000);
    const syncPromise = syncCustomProvidersToStepCliModelsFile(
      env,
      buildCliSyncProviders(["deepseek"], [deepseekView()]).providers,
      { modelsFilePath },
    );
    // 给旧实现留出完成锁外读段的时间窗（新实现在锁上等待，此延迟无影响），然后
    // 在仍持锁的状态下把外部提交写盘——这正是评审指出的「窗口内提交会被旧基线
    // 覆盖静默丢键」的竞态场景。
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(modelsFilePath, JSON.stringify(externallyCommitted, null, 2), "utf8");
    await releaseExternalLock();
    await syncPromise;

    const after = JSON.parse(await readFile(modelsFilePath, "utf8")) as { providers: Record<string, unknown> };
    assert.deepEqual(
      Object.keys(after.providers).sort(),
      ["deepseek", "external-probe", "ollama"],
      "合并基线必须是锁内读到的最新文件（外部提交的 external-probe 与既有 ollama 都不丢）",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveStepModelsFilePath：镜像 Step CLI 启动器的 config root 解析（含 agent dir 覆盖的父目录语义）", () => {
  const home = join("C:", "Users", "fixture-home");
  const explicitPath = join("C:", "tmp", "explicit-models.json");

  assert.equal(
    resolveStepModelsFilePath({ HOME: home }, { modelsFilePath: explicitPath }),
    explicitPath,
    "opts.modelsFilePath 显式覆盖优先（测试注入口）",
  );
  assert.equal(
    resolveStepModelsFilePath({ HOME: home }),
    join(home, ".stepcode", "models.json"),
    "默认落 config root（HOME/.stepcode）——与 CLI 启动器 join(resolveStepConfigRoot(), \"models.json\") 同款",
  );
  assert.equal(
    resolveStepModelsFilePath({ USERPROFILE: home }),
    join(home, ".stepcode", "models.json"),
    "HOME 缺失时回退 USERPROFILE（Windows）",
  );
  assert.equal(
    resolveStepModelsFilePath({ HOME: home, STEP_CODING_AGENT_DIR: join(home, ".stepcode", "agent") }),
    join(home, ".stepcode", "models.json"),
    "agent dir 覆盖时取其父目录（config root 与 agent 目录同级）",
  );
  assert.equal(
    resolveStepModelsFilePath({ HOME: home, STEPCODE_CONFIG_DIR: ".stepcode-fixture" }),
    join(home, ".stepcode-fixture", "models.json"),
    "STEPCODE_CONFIG_DIR 覆盖 config 目录名",
  );
});

test("syncCustomProvidersToStepCliModelsFile：默认路径按 env 解析（无 opts 时与 CLI 落点一致）", async () => {
  const home = await mkdtemp(join(tmpdir(), "step-cli-models-home-"));
  const env: Record<string, string | undefined> = { HOME: home };
  try {
    const result = await syncCustomProvidersToStepCliModelsFile(
      env,
      buildCliSyncProviders(["deepseek"], [deepseekView()]).providers,
    );
    const expectedPath = join(home, ".stepcode", "models.json");
    assert.equal(result.modelsFilePath, expectedPath, "无 opts 时默认写 HOME/.stepcode/models.json");
    assert.ok(existsSync(expectedPath), "文件已落盘到 CLI 会读取的位置");
    const parsed = JSON.parse(readFileSync(expectedPath, "utf8")) as { providers: Record<string, { apiKey: string }> };
    assert.equal(parsed.providers.deepseek.apiKey, DEEPSEEK_FIXTURE_KEY);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fixtures 只用假 Key（防真实凭据混入测试的守卫断言）", async () => {
  // 本测试自身不落任何文件；用守卫断言固化「假 Key 前缀」约定，防止后续维护者把真实凭据粘进来。
  const fakeKeyPattern = /^sk-fixture-[a-z0-9-]+$/;
  assert.match(DEEPSEEK_FIXTURE_KEY, fakeKeyPattern);
  assert.match(OPENAI_FIXTURE_KEY, fakeKeyPattern);
  assert.match(ROTATED_FIXTURE_KEY, fakeKeyPattern);
  // 顺带固化：测试进程的 HOME 与真实用户 HOME 隔离（mkdtemp 而非真实家目录）。
  assert.notEqual(tmpdir(), homedir(), "tmpdir 不应等于真实家目录（守卫，非功能性断言）");
});
