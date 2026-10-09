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
export function registerProviderToolIntegrity(pi, isManaged, { maxRepairs = 1 } = {}) {
  let calls = new Map();
  let repairs = 0, blocked = new Set();
  let repairCalls = new Map();
  pi.on("before_agent_start", () => { repairs = 0; blocked = new Set(); repairCalls = new Map(); });
  pi.on("context", event => ({ messages: event.messages.map(message => {
    const name = message.role === "toolResult" && repairCalls.get(message.toolCallId);
    if (!name) return message;
    // 原生 required 校验早于 tool_call；从工具结果上下文补充纠错原因，不能靠清空参数触发校验。
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
    return { ...message, isError: true, content: [...content, { type: "text", text:
      `[desktop-tool-arguments-repair] ${name} 所在批次的工具均未执行：响应参数不是完整、满足必填字段的 JSON 对象。请根据原任务重新生成完整的结构化工具调用；不要只确认收到，不要声称已经执行。只允许纠正一次。` }] };
  }) }));
  pi.on("tool_call", event => {
    if (blocked.has(event.toolCallId)) return { block: true, reason: "工具未执行：这一批调用包含不完整或无效的 JSON 参数。请重新生成整批正确的结构化工具调用，提供所有必填参数；不要输出 XML/tool_call 标签，也不要声称已执行。只允许纠正一次。" };
  });
  pi.on("message_start", (event) => {
    if (event.message?.role === "assistant") { calls = new Map(); blocked = new Set(); }
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
        const tools = pi.getAllTools?.();
        const required = Array.isArray(tools) ? tools.find(tool => tool.name === block.name)?.parameters?.required : undefined;
        if (Array.isArray(required) && required.some(name => !Object.hasOwn(args, name)))
          throw new Error("Provider tool arguments are missing required fields");
        return { ...block, arguments: args };
      });
      repairCalls = new Map();
      return { message: { ...message, content } };
    } catch {
      const toolCalls = message.content.filter(block => block.type === "toolCall");
      // 首次格式失败回传原生工具错误让模型纠正，绝不执行猜补后的参数。
      // 整批拦截可避免正确的兄弟调用在模型重试时被重复执行。
      if (repairs < maxRepairs && toolCalls.length && ![...calls.values()].some(entry => entry.invalid)) {
        repairs++;
        blocked = new Set(toolCalls.map(block => block.id));
        repairCalls = new Map(toolCalls.map(block => [block.id, block.name]));
        // 保留 SDK 已解析的参数作诊断；真实执行由整批 tool_call 拒绝，不伪造空参数。
        return { message: { ...message, stopReason: "toolUse" } };
      }
      return {
        message: {
          ...message,
          content: message.content.filter((block) => block.type !== "toolCall"),
          stopReason: "error",
          errorMessage:
            repairs > 0 ? "工具参数纠正后仍未通过校验，已停止本轮；这批工具未执行。请重试或切换模型。" : "工具参数不完整、无效或超出大小限制，已停止本轮；这批工具未执行。",
        },
      };
    } finally {
      calls = new Map();
    }
  });
}
