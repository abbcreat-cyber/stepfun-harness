import assert from "node:assert/strict";
import test from "node:test";
import { resolvePendingProviderDraftSave } from "../src/settings/model-provider-section/ProviderDraftSave.ts";
import { createProviderAdvancedDraftValues } from "../src/settings/model-provider-section/ProviderAdvancedDraft.ts";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "../src/settings/model-provider-section/ProviderModelMetadata.ts";

test("empty custom provider uses Chat Completions and does not create a phantom protocol edit", () => {
  const provider = {
    providerId: "custom",
    providerName: "custom",
    enabled: true,
    executable: false,
    hasPersonalConfig: true,
    personalConfig: { access: { type: "api-key" as const } },
    config: { access: { type: "api-key" as const } },
    models: [],
  };
  const draft = {
    nameValue: "custom",
    apiFormat: "openai-chat-completions" as const,
    baseUrlValue: "",
    apiKeyValue: "",
  };
  assert.equal(resolvePendingProviderDraftSave({ provider, draft, now: () => 1 }), null);
  const saved = resolvePendingProviderDraftSave({
    provider,
    draft: { ...draft, baseUrlValue: "https://fixture.example/v1" },
    now: () => 1,
  });
  assert.equal(saved?.personalConfig.api?.type, "openai-chat-completions");
});

const provider = {
  providerId: "custom",
  providerName: "custom",
  enabled: true,
  executable: true,
  hasPersonalConfig: true,
  personalConfig: {
    access: { type: "api-key" as const },
    api: { headers: { "X-Old": "old" }, compat: { supportsStore: false } },
  },
  config: {
    access: { type: "api-key" as const },
    api: {
      type: "openai-chat-completions" as const,
      baseUrl: "https://fixture.example/v1",
      headers: { "X-Old": "old" },
      compat: { supportsStore: false },
    },
  },
  models: [],
};

test("connection JSON fields save, reject invalid fields and allow clearing only personal overrides", () => {
  const draft = {
    nameValue: "custom",
    apiFormat: "openai-chat-completions" as const,
    baseUrlValue: "https://fixture.example/v1",
    apiKeyValue: "",
    ...createProviderAdvancedDraftValues(provider),
  };
  assert.equal(resolvePendingProviderDraftSave({ provider, draft, now: () => 1 }), null);
  const saved = resolvePendingProviderDraftSave({
    provider,
    draft: { ...draft, headersValue: '{"X-New":"new"}', authModeValue: "headers" },
    now: () => 1,
  });
  assert.deepEqual(saved?.personalConfig.api?.headers, { "X-New": "new" });
  assert.equal(saved?.personalConfig.api?.authMode, "headers");
  assert.deepEqual(saved?.personalConfig.api?.compat, { supportsStore: false });
  assert.throws(() =>
    resolvePendingProviderDraftSave({
      provider,
      draft: { ...draft, headersValue: '{"X-Invalid":false}' },
      now: () => 1,
    }),
  );
  assert.throws(() =>
    resolvePendingProviderDraftSave({
      provider,
      draft: { ...draft, compatValue: '{"silent_typo":true}' },
      now: () => 1,
    }),
  );
  const cleared = resolvePendingProviderDraftSave({
    provider,
    draft: { ...draft, headersValue: "" },
    now: () => 1,
  });
  assert.equal(cleared?.personalConfig.api?.headers, undefined);
  assert.deepEqual(cleared?.personalConfig.api?.compat, { supportsStore: false });
  const inheritedOnly = { ...provider, personalConfig: { access: { type: "api-key" as const } } };
  const explicit = resolvePendingProviderDraftSave({
    provider: inheritedOnly,
    draft: { ...draft, headersValue: '{"X-Old":"old"}' },
    now: () => 1,
  });
  assert.deepEqual(explicit?.personalConfig.api?.headers, { "X-Old": "old" });
});

const model = {
  kind: "candidate" as const,
  modelId: "unknown",
  builtin: false,
  hasPersonalConfig: true,
  executable: true,
  selectable: true,
  inheritedConfig: {
    enabled: true,
    properties: {
      contextWindow: 64000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      supportsToolCall: true,
    },
    optionSpecs: {
      reasoningLevel: { values: ["off", "high"], map: "{}" },
      maxOutputTokens: { max: 8192, map: "{}" },
    },
    native: { compat: { supportsStore: false } },
  },
  personalConfig: {
    properties: { inputFormat: { supportsImage: false } },
    native: { headers: { "X-Model": "fixture" } },
  },
  config: {
    enabled: true,
    properties: {
      contextWindow: 64000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      supportsToolCall: true,
    },
    optionSpecs: {
      reasoningLevel: { values: ["off", "high"], map: "{}" },
      maxOutputTokens: { max: 8192, map: "{}" },
    },
    native: { compat: { supportsStore: false }, headers: { "X-Model": "fixture" } },
  },
};

test("model native JSON saves, clears to inheritance, and keeps the manual vision opt-out", () => {
  const draft = createProviderModelDraftValues(model);
  const committed = resolveProviderModelDraftCommit({
    currentModel: model,
    apiType: "openai-chat-completions",
    draft: {
      ...draft,
      nativeConfigValue: '{"reasoning":false,"samplingParams":{"fixture_extra":true}}',
      supportsToolCallValue: false,
    },
  });
  assert.equal(committed.status, "commit");
  if (committed.status === "commit") {
    assert.equal(committed.model.personalConfig.native?.reasoning, false);
    assert.equal(committed.model.config.native?.compat?.supportsStore, false);
    assert.equal(committed.model.personalConfig.properties?.inputFormat?.supportsImage, false);
    assert.equal(committed.model.personalConfig.properties?.supportsToolCall, false);
  }
  const cleared = resolveProviderModelDraftCommit({
    currentModel: model,
    draft: { ...draft, nativeConfigValue: "" },
  });
  assert.equal(cleared.status, "commit");
  if (cleared.status === "commit") {
    assert.equal(cleared.model.personalConfig.native, undefined);
    assert.deepEqual(cleared.model.config.native, model.inheritedConfig.native);
  }
  const invalid = resolveProviderModelDraftCommit({
    currentModel: model,
    apiType: "openai-responses",
    draft: { ...draft, nativeConfigValue: '{"compat":{"supportsStore":false}}' },
  });
  assert.deepEqual(invalid, { status: "invalid", field: "nativeConfig" });
});
