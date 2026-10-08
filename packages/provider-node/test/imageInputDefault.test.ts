import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelConfig, ModelConfigRules } from "@zcode/provider";
import { withBuiltinImageInputDefault } from "../src/image-input-default.ts";

test("community image default keeps model declarations and manual opt-out", () => {
  const source = new ModelConfigRules([
    {
      type: "model",
      modelMatch: ".*",
      config: ModelConfig.fromData({ properties: { inputFormat: { supportsImage: false } } }),
    },
    {
      type: "model",
      modelMatch: "^text-only$",
      config: ModelConfig.fromData({ properties: { inputFormat: { supportsImage: false } } }),
    },
  ]);
  const adapted = withBuiltinImageInputDefault(source, true);
  const resolve = (rules: ModelConfigRules, modelId: string) =>
    rules.resolve({ providerId: "custom", modelId }).properties?.inputFormat?.supportsImage;
  assert.equal(resolve(adapted, "mimo-v2.6-pro"), true);
  assert.equal(resolve(adapted, "text-only"), false);
  assert.equal(resolve(source, "mimo-v2.6-pro"), false);
  const personal = new ModelConfigRules([
    {
      type: "provider-model",
      providerId: "custom",
      modelId: "mimo-v2.6-pro",
      config: ModelConfig.fromData({ properties: { inputFormat: { supportsImage: false } } }),
    },
  ]);
  assert.equal(
    resolve(ModelConfigRules.composeEffective(adapted, personal), "mimo-v2.6-pro"),
    false,
  );
});
