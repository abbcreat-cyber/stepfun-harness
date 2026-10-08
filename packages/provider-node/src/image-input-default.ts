import { ModelConfig, ModelConfigRules } from "@zcode/provider";

/** 上游通用兜底把未知模型都写成 text-only；社区默认允许图片，具体规则和个人关闭仍优先。 */
export function withBuiltinImageInputDefault(
  models: ModelConfigRules,
  enabled: boolean,
): ModelConfigRules {
  return new ModelConfigRules(
    models
      .rules()
      .map((rule) =>
        rule.type === "model" && rule.modelMatch === ".*"
          ? {
              ...rule,
              config: rule.config.overlay(
                ModelConfig.fromData({ properties: { inputFormat: { supportsImage: enabled } } }),
              ),
            }
          : rule,
      ),
  );
}
