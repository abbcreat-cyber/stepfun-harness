import {
  COMMUNICATION_COMMAND,
  COMMUNICATION_DESCRIPTION,
  applyCommunicationHeaders,
  applyCommunicationPayload,
  communicationBinding,
  communicationFetch,
} from "../provider-communication.mjs";
import { normalizeSseResponse } from "../provider-sse-transport.mjs";
import { getApiProvider } from "@step-harness/providers";
import { randomUUID } from "node:crypto";
import { createProviderRequestOptions } from "./provider-request-options.mjs";
import { registerProviderToolIntegrity } from "../provider-tool-integrity.mjs";

/** 原 Step 扩展负责请求补充，仍由原生 streamSimple 消费 HTTP/SSE。 */
export default function providerCommunication(pi) {
  if (typeof getApiProvider !== "function" || typeof pi.registerProvider !== "function")
    throw new Error("Native provider communication hooks are unavailable");
  const bindings = new Map();
  let initialized = false;
  const generation = randomUUID();
  const key = (model) => `${model.provider}\0${model.id}`;
  const current = (model) => communicationBinding(model, bindings.get(key(model)));
  const requestOptions = createProviderRequestOptions(pi, { bindings, key, current, generation });
  registerProviderToolIntegrity(pi, (model) => !!model && bindings.has(key(model)));

  pi.on("before_provider_headers", (event, ctx) => {
    const binding = bindings.get(ctx.model && key(ctx.model));
    if (binding) applyCommunicationHeaders(event.headers, ctx.model, binding);
  });
  pi.on("before_provider_request", (event, ctx) => {
    const binding = bindings.get(ctx.model && key(ctx.model));
    if (binding) return applyCommunicationPayload(event.payload, ctx.model, binding);
  });
  pi.on("tool_call", (_event, ctx) => {
    if (bindings.get(ctx.model && key(ctx.model))?.supportsToolCall === false)
      return { block: true, reason: "This model has tool calls disabled" };
  });

  pi.on("session_start", (_event, ctx) => {
    if (initialized) return;
    const providers = new Map();
    for (const model of ctx.modelRegistry.getAll()) {
      const binding = communicationBinding(model);
      if (!binding) continue;
      bindings.set(key(model), binding);
      const previous = providers.get(model.provider);
      if (previous && previous !== model.api)
        throw new Error("Managed provider models must share one protocol");
      providers.set(model.provider, model.api);
    }
    for (const [providerId, api] of providers) {
      // 捕获协议函数，不能再按 provider 分派，否则 wrapper 会递归调用自己。
      const native = getApiProvider(api)?.streamSimple;
      if (typeof native !== "function")
        throw new Error("Native streamSimple communication seam is unavailable");
      pi.registerProvider(providerId, {
        api,
        streamSimple(model, context, options = {}) {
          const binding = current(model);
          if (!binding) throw new Error("Managed provider communication binding is missing");
          requestOptions.watchAbort(options.signal);
          // 官方 hook runner 会吞异常；真实 stream/fetch seam 的校验必须在 runner 之外执行。
          const validatePayload = (payload) =>
            requestOptions.apply(model, applyCommunicationPayload(payload, model, binding));
          const mappedReasoning = requestOptions.isReasoningMapped(model);
          // 在 SDK 预算计算前去除禁用工具，避免不存在的工具 schema 吃掉可用输出额度。
          const nativeContext =
            binding.supportsToolCall === false ? { ...context, tools: [] } : context;
          // Simple options 的 "off" 是 truthy，Anthropic 会误当开启；映射由 CEL 独占其字段。
          const nativeModel = mappedReasoning ? { ...model, reasoning: false } : model;
          return native(nativeModel, nativeContext, {
            ...options,
            ...(mappedReasoning ? { reasoning: undefined, thinkingBudgets: undefined } : {}),
            onPayload: async (payload) =>
              validatePayload((await options.onPayload?.(payload, model)) ?? payload),
            fetch: communicationFetch(
              options.fetch ?? globalThis.fetch,
              model,
              binding,
              api === "anthropic-messages" ? normalizeSseResponse : undefined,
              { ...options.headers },
            ),
          });
        },
      });
    }
    requestOptions.initialize();
    initialized = true;
    pi.registerCommand(COMMUNICATION_COMMAND, {
      description: COMMUNICATION_DESCRIPTION,
      handler: requestOptions.handler,
    });
  });
}
