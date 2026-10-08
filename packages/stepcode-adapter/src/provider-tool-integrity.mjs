const MAX_ARGUMENT_CHARS = 1024 * 1024;

function boundedObjectJson(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Provider tool arguments must be a JSON object");
  const json = JSON.stringify(value);
  if (typeof json !== "string" || json.length > MAX_ARGUMENT_CHARS)
    throw new Error("Provider tool argument JSON exceeds the limit");
  return json;
}

/** 原生公开增量提供 raw JSON；只做终态完整性校验，不解释 SSE 或执行工具。 */
export function registerProviderToolIntegrity(pi, isManaged) {
  let calls = new Map();
  pi.on("message_start", (event) => {
    if (event.message?.role === "assistant") calls = new Map();
  });
  pi.on("message_update", (event, ctx) => {
    if (!isManaged(ctx.model)) return;
    const update = event.assistantMessageEvent;
    if (update?.type === "toolcall_start") {
      const initial = update.partial?.content?.[update.contentIndex];
      const entry = { raw: "", hasRaw: false };
      if (ctx.model.api === "anthropic-messages" && initial?.arguments !== undefined) {
        // 初始 input 已经过外层 JSON parser；先检查上限，再复制，不能先 clone 巨大对象。
        try {
          entry.initial = JSON.parse(boundedObjectJson(initial.arguments));
        } catch {
          entry.invalid = true;
        }
      }
      calls.set(update.contentIndex, entry);
    } else if (update?.type === "toolcall_delta") {
      const entry = calls.get(update.contentIndex) ?? { raw: "", hasRaw: false };
      entry.hasRaw = true;
      if (
        typeof update.delta !== "string" ||
        entry.raw.length + update.delta.length > MAX_ARGUMENT_CHARS
      )
        entry.invalid = true;
      else entry.raw += update.delta;
      calls.set(update.contentIndex, entry);
    }
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message?.role !== "assistant" || !isManaged(ctx.model)) return;
    const message = event.message;
    if (["error", "aborted"].includes(message.stopReason)) {
      calls = new Map();
      return {
        message: {
          ...message,
          content: message.content.filter((block) => block.type !== "toolCall"),
        },
      };
    }
    try {
      const content = message.content.map((block, index) => {
        if (block.type !== "toolCall") return block;
        const entry = calls.get(index);
        if (!entry || entry.invalid || (!entry.hasRaw && entry.initial === undefined))
          throw new Error("Provider did not expose complete tool argument JSON");
        const args = entry.hasRaw ? JSON.parse(entry.raw) : entry.initial;
        boundedObjectJson(args);
        return { ...block, arguments: args };
      });
      return { message: { ...message, content } };
    } catch {
      return {
        message: {
          ...message,
          content: message.content.filter((block) => block.type !== "toolCall"),
          stopReason: "error",
          errorMessage:
            "Provider returned incomplete or invalid tool argument JSON; no tool was executed",
        },
      };
    } finally {
      calls = new Map();
    }
  });
}
