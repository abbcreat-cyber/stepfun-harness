import { z } from "zod";

/** 原生 SDK 的有限配置合同；未知字段必须报错，不能在持久化时静默删除。 */
export const nativeHeadersDataSchema = z
  .record(
    z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "HTTP header 名称无效"),
    z.string().refine((value) => !/[\r\n]/.test(value), "HTTP header 值不能包含换行"),
  )
  .readonly();

const bool = z.boolean().optional();
const sessionAffinityFormat = z.enum(["openai", "openai-nosession", "openrouter"]).optional();
const templateValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .object({
      $var: z.enum(["thinking.enabled", "thinking.effort", "thinking.budget"]),
      omitWhenOff: bool,
    })
    .strict(),
]);
const strings = z.array(z.string()).optional();
const percentile = z
  .union([
    z.number(),
    z
      .object({
        p50: z.number().optional(),
        p75: z.number().optional(),
        p90: z.number().optional(),
        p99: z.number().optional(),
      })
      .strict(),
  ])
  .optional();
const rates = {
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
};
const cost = z
  .object({
    ...rates,
    tiers: z.array(z.object({ ...rates, inputTokensAbove: z.number() }).strict()).optional(),
  })
  .strict();

export const nativeChatCompletionsCompatDataSchema = z
  .object({
    supportsStore: bool,
    supportsDeveloperRole: bool,
    supportsReasoningEffort: bool,
    supportsUsageInStreaming: bool,
    supportsFinishReason: bool,
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    requiresToolResultName: bool,
    requiresAssistantAfterToolResult: bool,
    requiresThinkingAsText: bool,
    requiresReasoningContentOnAssistantMessages: bool,
    thinkingFormat: z
      .enum([
        "openai",
        "openrouter",
        "deepseek",
        "together",
        "baseten",
        "zai",
        "qwen",
        "chat-template",
        "qwen-chat-template",
        "string-thinking",
        "ant-ling",
      ])
      .optional(),
    chatTemplateKwargs: z.record(z.string(), templateValue).optional(),
    chatTemplateArgs: z.record(z.string(), templateValue).optional(),
    openRouterRouting: z
      .object({
        allow_fallbacks: bool,
        require_parameters: bool,
        data_collection: z.enum(["deny", "allow"]).optional(),
        zdr: bool,
        enforce_distillable_text: bool,
        order: strings,
        only: strings,
        ignore: strings,
        quantizations: strings,
        sort: z
          .union([
            z.string(),
            z
              .object({ by: z.string().optional(), partition: z.string().nullable().optional() })
              .strict(),
          ])
          .optional(),
        max_price: z
          .object(
            Object.fromEntries(
              ["prompt", "completion", "image", "audio", "request"].map((key) => [
                key,
                z.union([z.number(), z.string()]).optional(),
              ]),
            ),
          )
          .strict()
          .optional(),
        preferred_min_throughput: percentile,
        preferred_max_latency: percentile,
      })
      .strict()
      .optional(),
    vercelGatewayRouting: z.object({ only: strings, order: strings }).strict().optional(),
    zaiToolStream: bool,
    thinkingTokenBudgetField: z
      .enum(["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"])
      .optional(),
    supportsThinkingTokenBudget: bool,
    supportsOpenAIGrammarTools: bool,
    supportsStrictMode: bool,
    cacheControlFormat: z.literal("anthropic").optional(),
    sendSessionAffinityHeaders: bool,
    deferredToolsMode: z.literal("kimi").optional(),
    sessionAffinityFormat,
    supportsLongCacheRetention: bool,
  })
  .strict();

export const nativeResponsesCompatDataSchema = z
  .object({
    supportsDeveloperRole: bool,
    sessionAffinityFormat,
    supportsLongCacheRetention: bool,
    supportsStrictMode: bool,
    supportsOpenAIGrammarTools: bool,
    supportsAdditionalTools: bool,
    supportsToolSearch: bool,
    supportsExplicitPromptCacheMode: bool,
  })
  .strict();

export const nativeAnthropicCompatDataSchema = z
  .object({
    supportsEagerToolInputStreaming: bool,
    supportsLongCacheRetention: bool,
    sendSessionAffinityHeaders: bool,
    supportsCacheControlOnTools: bool,
    supportsTemperature: bool,
    forceAdaptiveThinking: bool,
    allowEmptySignature: bool,
    supportsStrictTools: bool,
    allowedFallbackModels: z
      .array(z.object({ provider: z.string(), model: z.string(), cost }).strict())
      .optional(),
    supportsToolReferences: bool,
  })
  .strict();

export const nativeCompatDataSchema = z
  .object({
    ...nativeChatCompletionsCompatDataSchema.shape,
    ...nativeResponsesCompatDataSchema.shape,
    ...nativeAnthropicCompatDataSchema.shape,
  })
  .strict();

export function nativeCompatSchemaForApi(apiType: string) {
  if (apiType === "openai-chat-completions") return nativeChatCompletionsCompatDataSchema;
  if (apiType === "openai-responses") return nativeResponsesCompatDataSchema;
  return nativeAnthropicCompatDataSchema;
}

export const nativeThinkingLevelMapDataSchema = z
  .object({
    off: z.string().nullable().optional(),
    minimal: z.string().nullable().optional(),
    low: z.string().nullable().optional(),
    medium: z.string().nullable().optional(),
    high: z.string().nullable().optional(),
    xhigh: z.string().nullable().optional(),
    max: z.string().nullable().optional(),
  })
  .strict();

// 请求身份、输入、流与工具由协议适配器拥有；附加 JSON 不能篡改这些不变量。
const ownedPayloadKeys = new Set(["model", "messages", "input", "stream", "tools", "tool_choice"]);
export const nativeSamplingParamsDataSchema = z
  .record(z.string(), z.json())
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (ownedPayloadKeys.has(key))
        context.addIssue({
          code: "custom",
          path: [key],
          message: `原生协议拥有 ${key}，不能用附加参数覆盖`,
        });
    }
  });

export const nativeModelConfigDataSchema = z
  .object({
    headers: nativeHeadersDataSchema.nullable().optional(),
    compat: nativeCompatDataSchema.nullable().optional(),
    thinkingLevelMap: nativeThinkingLevelMapDataSchema.nullable().optional(),
    samplingParams: nativeSamplingParamsDataSchema.nullable().optional(),
    reasoning: z.boolean().nullable().optional(),
  })
  .strict();

export function nativeModelSchemaForApi(apiType: string) {
  return nativeModelConfigDataSchema
    .extend({ compat: nativeCompatSchemaForApi(apiType).nullable().optional() })
    .superRefine((value, context) => {
      if (
        apiType === "anthropic-messages" &&
        value.samplingParams &&
        "parallel_tool_calls" in value.samplingParams
      )
        context.addIssue({
          code: "custom",
          path: ["samplingParams", "parallel_tool_calls"],
          message: "Anthropic Messages 不支持顶层 parallel_tool_calls",
        });
    });
}

export type NativeModelConfigData = Readonly<z.infer<typeof nativeModelConfigDataSchema>>;
export type NativeCompatData = Readonly<z.infer<typeof nativeCompatDataSchema>>;
