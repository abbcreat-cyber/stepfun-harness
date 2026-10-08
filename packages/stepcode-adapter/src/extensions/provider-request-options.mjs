import { compileModelOptionMaps, compileModelOptionMap } from "@zcode/model-option-map";
import { OPTIONS_RECEIPT_KEY } from "../provider-request-options.mjs";

const protectedFields = new Set([
  "model",
  "messages",
  "input",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
]);
const nonemptyMap = (source) => typeof source === "string" && source.trim() !== "{}";

/** 只保存当前 SDK 轮次的 transport values；业务选择和历史仍由会话 owner 管理。 */
export function createProviderRequestOptions(pi, { bindings, key, current, generation }) {
  const programs = new Map();
  let prepared, active, standby, signalCleanup;
  let userMessages = 0;
  const clear = () => {
    prepared = undefined;
    active = undefined;
    standby = undefined;
    signalCleanup?.();
    signalCleanup = undefined;
  };
  // before_agent_start 只标记新的用户 prompt；原生重试/压缩续跑会再次 agent_start。
  pi.on("before_agent_start", () => {
    active = prepared ?? standby;
    prepared = undefined;
    standby = undefined;
    userMessages = 0;
  });
  pi.on("agent_settled", () => {
    active = undefined;
    prepared = undefined;
    signalCleanup?.();
    signalCleanup = undefined;
  });
  pi.on("session_switch", () => {
    clear();
  });
  pi.on("model_select", () => {
    clear();
  });
  // 只证明真实 RPC 输入已进入 SDK；不保存文本、队列或业务选择。
  pi.on("input", (event) => {
    if (standby && event.source === "rpc") standby.inputSeen = true;
  });
  pi.on("message_start", (event) => {
    if (event.message?.role !== "user") return;
    userMessages++;
    if (standby?.inputSeen && userMessages > standby.afterUserCount) standby = undefined;
  });
  const capabilities = (modelKey) => {
    const program = programs.get(modelKey);
    return {
      hasMappings: !!program,
      reasoningMapped: !!program?.reasoningMapped,
      maxOutputMapped: !!program?.maxOutputMapped,
    };
  };
  return {
    initialize() {
      for (const [modelKey, binding] of bindings) {
        const specs = binding.optionSpecs ?? {},
          reasoningMapped = nonemptyMap(specs.reasoningLevel?.map),
          maxOutputMapped = nonemptyMap(specs.maxOutputTokens?.map);
        if (!reasoningMapped && !maxOutputMapped) continue;
        const maps = {
          reasoningLevel: { map: specs.reasoningLevel?.map ?? "{}" },
          maxOutputTokens: { map: specs.maxOutputTokens?.map ?? "{}" },
        };
        programs.set(modelKey, {
          maps: compileModelOptionMaps(maps),
          reasoning: compileModelOptionMap(maps.reasoningLevel.map, "reasoningLevel"),
          maxOutput: compileModelOptionMap(maps.maxOutputTokens.map, "maxOutputTokens"),
          reasoningMapped,
          maxOutputMapped,
          specs,
        });
      }
    },
    isReasoningMapped(model) {
      return capabilities(key(model)).reasoningMapped;
    },
    handler(args, ctx) {
      let envelope = {};
      try {
        envelope = args ? JSON.parse(args) : {};
        if (!ctx.isIdle() && !["carry", "discard"].includes(envelope.action))
          throw new Error("Cannot change provider request options while the agent is busy");
        if (
          !ctx.model ||
          (envelope.providerId && envelope.providerId !== ctx.model.provider) ||
          (envelope.modelId && envelope.modelId !== ctx.model.id) ||
          (envelope.generation && envelope.generation !== generation)
        )
          throw new Error("Provider option command has a stale client/model binding");
        const modelKey = key(ctx.model),
          binding = current(ctx.model),
          program = programs.get(modelKey);
        const result = {
          version: 1,
          generation,
          nonce: envelope.nonce,
          requestId: envelope.requestId,
          providerId: ctx.model.provider,
          modelId: ctx.model.id,
          ...capabilities(modelKey),
        };
        const values = binding?.optionSpecs?.reasoningLevel?.values;
        if (Array.isArray(values) && values.length) {
          const probeLevel =
            ["disabled", "off", "minimal", "low"].find((value) => values.includes(value)) ??
            values[0];
          result.probeOptions = { reasoningLevel: probeLevel };
        }
        if (envelope.action === "prepare" || envelope.action === "carry") {
          if (active && envelope.action === "prepare")
            throw new Error(
              "Cannot change provider request options before the current prompt settles",
            );
          if (prepared && envelope.action === "prepare")
            throw new Error("Provider request options already await a prompt");
          if (program) {
            const reasoningLevel = envelope.options?.reasoningLevel;
            if (
              program.reasoningMapped &&
              (typeof reasoningLevel !== "string" ||
                !program.specs.reasoningLevel.values?.includes(reasoningLevel))
            )
              throw new Error(
                "Mapped reasoningLevel requires the original declared desktop selection",
              );
            const maxOutputTokens = program.specs.maxOutputTokens?.max;
            if (
              program.maxOutputMapped &&
              (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)
            )
              throw new Error("Mapped maxOutputTokens requires the declared model limit");
            const candidate = {
              modelKey,
              binding,
              requestId: envelope.requestId,
              values: {
                reasoningLevel: reasoningLevel ?? "off",
                maxOutputTokens: maxOutputTokens ?? ctx.model.maxTokens,
              },
            };
            if (envelope.action === "carry") {
              for (const previous of [active, prepared, standby])
                if (
                  previous &&
                  (previous.modelKey !== candidate.modelKey ||
                    JSON.stringify(previous.values) !== JSON.stringify(candidate.values))
                )
                  throw new Error("Busy continuation requires the same model and original options");
              if (prepared) {
                prepared.requestIds ??= new Set([prepared.requestId]);
                prepared.requestIds.add(envelope.requestId);
              } else {
                const requestIds = standby?.requestIds ?? new Set();
                requestIds.add(envelope.requestId);
                standby = {
                  ...candidate,
                  requestIds,
                  inputSeen: false,
                  afterUserCount: Math.max(1, userMessages),
                };
              }
              result.carried = true;
            } else prepared = candidate;
          }
        } else if (envelope.action === "discard") {
          if (prepared?.requestId === envelope.requestId && prepared.modelKey === modelKey)
            prepared = undefined;
          if (standby?.modelKey === modelKey && standby.requestIds.has(envelope.requestId)) {
            standby.requestIds.delete(envelope.requestId);
            if (!standby.requestIds.size) standby = undefined;
          }
        } else if (envelope.action && envelope.action !== "describe")
          throw new Error("Provider option command action is unsupported");
        ctx.ui.setStatus(OPTIONS_RECEIPT_KEY, JSON.stringify(result));
      } catch (error) {
        ctx.ui.setStatus(
          OPTIONS_RECEIPT_KEY,
          JSON.stringify({
            version: 1,
            nonce: envelope.nonce,
            requestId: envelope.requestId,
            error: error.message,
          }),
        );
      }
    },
    watchAbort(signal) {
      if (!signal || active?.signal === signal) return;
      signalCleanup?.();
      const abort = () => {
        prepared = undefined;
        standby = undefined;
      };
      signal.addEventListener("abort", abort, { once: true });
      signalCleanup = () => signal.removeEventListener("abort", abort);
      if (active) active.signal = signal;
      if (signal.aborted) abort();
    },
    apply(model, payload) {
      const modelKey = key(model),
        program = programs.get(modelKey);
      if (!program) return payload;
      if (!active || active.modelKey !== modelKey)
        throw new Error("Mapped provider options were not prepared for this prompt");
      current(model);
      for (const patch of [
        program.reasoning.evaluate(active.values.reasoningLevel),
        program.maxOutput.evaluate(active.values.maxOutputTokens),
      ])
        for (const field of Object.keys(patch))
          if (protectedFields.has(field))
            throw new Error(`Option map field '${field}' is protected`);
      return program.maps.apply(payload, active.values);
    },
  };
}
