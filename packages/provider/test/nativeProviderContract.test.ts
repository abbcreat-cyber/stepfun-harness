import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelConfig,
  parseModelConfig,
  parseProviderConfig,
  createRegistryModelConfig,
  createRegistryProviderConfig,
  serializeRegistryModelConfig,
  serializeRegistryProviderConfig,
  ModelConfigRules,
  clearManualModelConfig,
  extractManualModelConfig,
} from "../src/index.ts";

const completeModel = {
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 64000,
    inputFormat: {
      supportsText: true,
      supportsImage: true,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: true,
  },
  optionSpecs: {
    reasoningLevel: { values: ["off", "high"], map: "{}" },
    maxOutputTokens: { max: 8192, map: "{}" },
  },
};

test("native model settings survive parse, overlay and Registry serialization", () => {
  const native = {
    headers: { "X-Model": "fixture" },
    compat: { supportsStore: false, maxTokensField: "max_tokens" as const },
    thinkingLevelMap: { off: null, high: "strong" },
    samplingParams: { temperature: 0.4, fixture_extra: { nested: [true, null] } },
    reasoning: true,
  };
  const model = parseModelConfig({ ...completeModel, native });
  const updated = model.overlay(ModelConfig.fromData({ native: { reasoning: false } }));
  assert.deepEqual(updated.toJSON().native, { ...native, reasoning: false });
  const result = createRegistryModelConfig(updated);
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(serializeRegistryModelConfig(result.config).native, updated.native);
  assert.deepEqual(updated.overlay(ModelConfig.fromData({ native: { headers: null } })).native, {
    ...native,
    headers: null,
    reasoning: false,
  });
  assert.equal(updated.overlay(ModelConfig.fromData({ native: null })).native, null);
});

test("provider compatibility settings and headers survive Registry serialization", () => {
  const api = {
    type: "openai-chat-completions" as const,
    baseUrl: "https://fixture.example/v1",
    authMode: "api-key" as const,
    headers: { "X-Provider": "fixture" },
    compat: { supportsStore: false, supportsStrictMode: false },
  };
  const provider = parseProviderConfig({
    group: "standard-personal",
    access: { type: "api-key", apiKey: "fixture" },
    api,
  });
  const result = createRegistryProviderConfig(provider);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(serializeRegistryProviderConfig(result.config).api, api);
});

test("native fields reject unsupported keys, invalid headers and protocol-owned body fields", () => {
  for (const native of [
    { compat: { silent_typo: true } },
    { thinkingLevelMap: { high: 2 } },
    { headers: { "X-Invalid": "value\r\nInjected: fixture" } },
    { samplingParams: { stream: false } },
    { samplingParams: { model: "override-identity" } },
  ])
    assert.throws(() => parseModelConfig({ native }));
});

test("provider compatibility is validated against its selected protocol", () => {
  const provider = parseProviderConfig({
    group: "standard-personal",
    access: { type: "api-key", apiKey: "fixture" },
    api: {
      type: "openai-responses",
      baseUrl: "https://fixture.example/v1",
      compat: { supportsStore: false },
    },
  });
  const result = createRegistryProviderConfig(provider);
  assert.equal(result.ok, false);
});

test("authentication modes allow explicit no-key connections and preserve account validation", () => {
  const create = (access: unknown, api: Record<string, unknown>) =>
    createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access,
        api: { type: "openai-chat-completions", baseUrl: "https://fixture.example/v1", ...api },
      }),
    );
  assert.equal(create({ type: "api-key" }, {}).ok, false);
  assert.equal(create({ type: "api-key", apiKey: " " }, { authMode: "api-key" }).ok, false);
  assert.equal(create({ type: "api-key" }, { authMode: "none" }).ok, true);
  assert.equal(
    create({ type: "api-key" }, { authMode: "headers", headers: { "X-Auth": "fixture" } }).ok,
    true,
  );
  assert.equal(create({ type: "api-key" }, { authMode: "headers", headers: {} }).ok, false);
  assert.equal(create({ type: "zhipu-coding-plan-api-key" }, { authMode: "none" }).ok, false);
  assert.equal(
    create(
      { type: "zhipu-account", accountType: "bigmodel", mode: "start-plan", entitled: true },
      { authMode: "none" },
    ).ok,
    false,
  );
  assert.equal(
    create(
      { type: "zhipu-account", accountType: "bigmodel", mode: "start-plan", entitled: true },
      {},
    ).ok,
    true,
  );
});

test("model compatibility and sampling parameters are validated against the selected protocol", () => {
  const unsupported = parseModelConfig({
    ...completeModel,
    native: { compat: { supportsStore: false } },
  });
  assert.equal(createRegistryModelConfig(unsupported, ["model"], "openai-responses").ok, false);
  const extra = parseModelConfig({
    ...completeModel,
    native: { samplingParams: { fixture_extra: true } },
  });
  assert.equal(createRegistryModelConfig(extra, ["model"], "anthropic-messages").ok, true);
  const parallel = parseModelConfig({
    ...completeModel,
    native: { samplingParams: { parallel_tool_calls: false } },
  });
  assert.equal(createRegistryModelConfig(parallel, ["model"], "anthropic-messages").ok, false);
  assert.equal(createRegistryModelConfig(parallel, ["model"], "openai-chat-completions").ok, true);
});

test("old manual rules inherit newly optional native/tool leaves and clear remains reversible", () => {
  const baseline = { ...completeModel, native: { compat: { supportsStore: false } } };
  const manual = extractManualModelConfig(completeModel);
  delete manual.properties.supportsToolCall;
  const rules = new ModelConfigRules([
    { type: "model", modelMatch: ".*", config: ModelConfig.fromData(baseline) },
    {
      type: "manual-provider-model",
      providerId: "custom",
      modelId: "unknown",
      config: ModelConfig.fromData(manual),
    },
  ]);
  const result = rules.resolve({ providerId: "custom", modelId: "unknown" });
  assert.deepEqual(result.native, baseline.native);
  assert.equal(result.properties?.supportsToolCall, true);
  assert.equal(createRegistryModelConfig(result).ok, true);
  const cleared = clearManualModelConfig({ ...manual, native: { reasoning: false } });
  assert.equal(cleared.native, undefined);
  assert.equal(cleared.properties?.supportsToolCall, undefined);
});

test("native snapshots detach and freeze nested caller-owned data", () => {
  const native = { samplingParams: { extra: { list: [1] } } };
  const model = ModelConfig.fromData({ native });
  native.samplingParams.extra.list.push(2);
  assert.deepEqual(model.native?.samplingParams, { extra: { list: [1] } });
  assert.equal(Object.isFrozen(model.native?.samplingParams?.extra), true);
});
