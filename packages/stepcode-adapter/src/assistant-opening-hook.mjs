import { visibleAssistantText } from "./assistant-text.mjs";

export const OPENING_REQUIRED = "[desktop-opening-required]";
export const OPENING_STOPPED = "[desktop-opening-stopped]";

/** 只准入工具，不创造 user 消息或额外执行器；补正最多一次，避免无限续跑。 */
export function registerAssistantOpeningHook(pi, enabled = () => true) {
  let required = false, spoken = false, firstBlockedMessage, stop = false;
  pi.on("before_agent_start", event => {
    required = !/只(?:给|要|需).{0,6}(?:结果|答案)|不要.{0,6}(?:过程|说明)|(?:仅|只).{0,5}(?:输出|返回).{0,5}JSON|(?:only|just)\s+(?:the\s+)?(?:answer|result|json)/i.test(event.prompt ?? "");
    spoken = false; firstBlockedMessage = undefined; stop = false;
  });
  pi.on("message_end", event => {
    if (event.message?.role !== "assistant") return;
    const text = (event.message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("");
    if (visibleAssistantText(text).trim()) spoken = true;
  });
  pi.on("tool_call", (_event, ctx) => {
    if (!enabled() || !required || spoken) return;
    const message = ctx.sessionManager.getLeafId();
    if (firstBlockedMessage === undefined) firstBlockedMessage = message;
    else if (message !== firstBlockedMessage) stop = true;
    return {
      block: true,
      ...(stop ? { terminate: true } : {}),
      reason: stop
        ? `${OPENING_STOPPED} 尚未执行工具。模型再次跳过开场说明，本轮停止，不再自动重试。`
        : `${OPENING_REQUIRED} 尚未执行工具。请先用正常 assistant 正文简短说明当前任务的目标和第一步，再重新调用需要的工具。不要调用新的工具来代替这句说明。`,
    };
  });
}

export function openingDeferral(result) {
  const text = typeof result === "string" ? result : (result?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("");
  if (text.includes("[desktop-hooks-stopped]")) return "工具未执行：内置钩子配置无法读取，本轮已停止。";
  if (text.includes(OPENING_STOPPED)) return "工具未执行：缺少开场说明，本轮已停止。";
  if (text.includes(OPENING_REQUIRED)) return "工具尚未执行，等待补充开场说明。";
  return null;
}
