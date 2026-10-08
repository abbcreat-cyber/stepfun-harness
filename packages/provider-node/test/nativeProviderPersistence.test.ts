import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ModelConfig,
  ModelConfigRules,
  ProviderConfigMap,
  parseProviderConfig,
} from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "../src/personal-provider-config-repository.ts";

test("personal atomic persistence keeps native configuration and explicit null clears after reopening", async () => {
  const root = resolve(process.env.STEPCODE_PROVIDER_CONTRACT_TEST_ROOT ?? tmpdir());
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, "provider-native-"));
  const filePath = join(folder, "personal.json");
  const first = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
  const second = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
  try {
    const provider = parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key" },
      api: {
        type: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:12345/v1",
        authMode: "none",
        headers: { "X-Source": "fixture" },
        compat: { supportsStore: false },
      },
      personalModelIds: ["unknown"],
    });
    const native = {
      headers: null,
      compat: { maxTokensField: "max_tokens" as const },
      thinkingLevelMap: { off: null, high: "strong" },
      samplingParams: { fixture_extra: [true, null] },
      reasoning: false,
    };
    await first.update(() => ({
      providers: new ProviderConfigMap([["custom", provider]]),
      models: new ModelConfigRules([
        {
          type: "provider-model",
          providerId: "custom",
          modelId: "unknown",
          config: ModelConfig.fromData({ native }),
        },
      ]),
    }));
    const reopened = await second.read();
    assert.deepEqual(reopened.providers.get("custom")?.toJSON(), provider.toJSON());
    assert.deepEqual(reopened.models.getExact("custom", "unknown")?.native, native);
    await second.update((current) => ({
      ...current,
      models: current.models.setExact("custom", "unknown", ModelConfig.fromData({ native: null })),
    }));
    const cleared = await first.read();
    assert.equal(cleared.models.getExact("custom", "unknown")?.native, null);
    assert.equal(cleared.providers.get("custom")?.api?.authMode, "none");
  } finally {
    first.dispose();
    second.dispose();
    assert.equal(dirname(folder), root);
    await rm(folder, { recursive: true, force: true });
  }
});
