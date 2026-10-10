import { visibleAssistantText } from "./assistant-text.mjs";

export const OPENING_REQUIRED = "[desktop-opening-required]";
export const OPENING_STOPPED = "[desktop-opening-stopped]";
export const OPENING_TIMING_POLICY = `<desktop_opening_timing>
对于需要实际执行的任务，第一条对用户可见的正文应尽早说明具体目标和第一步：先依据已知请求做最小必要判断，立即用用户的语言说一两句，再展开详细分析、设计、编码或长工具参数。不要先在思考中完成整份作品、完整代码或全套方案，才补一句“我来做”。第一性原理要求服务于任务，不是开场前必须完成的长篇分析。
开场必须贴合当前任务，让用户知道你将产出什么、首先处理哪个具体部分；不复述空泛流程，不只说“收到/正在处理/请稍等”，不声称尚未执行的操作已经成功。不为满足开场而增加无关工具调用、扫描目录或重复确认。开场之后再充分思考和执行，保持成果质量。简单问答直接回答，明确只要结果或结构化格式时遵从用户。
</desktop_opening_timing>`;

function requiresOpening(prompt) {
  return !/只(?:给|要|需).{0,6}(?:结果|答案)|不要.{0,6}(?:过程|说明)|(?:仅|只).{0,5}(?:输出|返回).{0,5}JSON|(?:only|just)\s+(?:the\s+)?(?:answer|result|json)/i.test(
    prompt ?? "",
  );
}
export function withOpeningTimingPolicy(systemPrompt, prompt, enabled = true) {
  const base = (systemPrompt ?? "").replace(
    /\n?<desktop_opening_timing>[\s\S]*?<\/desktop_opening_timing>/g,
    "",
  );
  return enabled && requiresOpening(prompt) ? `${base}\n${OPENING_TIMING_POLICY}` : base;
}

export function meaningfulOpening(text) {
  const visible = visibleAssistantText(text).trim();
  const compact = visible.replace(/[^\p{L}\p{N}]/gu, "");
  return (
    Boolean(visible) &&
    !/^(?:好的|好|收到|明白|正在处理|请稍等|稍等|我来处理|我会处理|让我想想|我先看看|ok|okay|gotit|onit|workingonit|pleasewait)+$/i.test(
      compact,
    )
  );
}

/** 只准入工具，不创造 user 消息或额外执行器；补正最多一次，避免无限续跑。 */
export function registerAssistantOpeningHook(pi, enabled = () => true) {
  let required = false,
    spoken = false,
    firstBlockedMessage,
    stop = false;
  pi.on("before_agent_start", (event) => {
    required = requiresOpening(event.prompt);
    spoken = false;
    firstBlockedMessage = undefined;
    stop = false;
  });
  pi.on("message_end", (event) => {
    if (event.message?.role !== "assistant") return;
    const text = (event.message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (meaningfulOpening(text)) spoken = true;
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
  const text =
    typeof result === "string"
      ? result
      : (result?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  if (text.includes("[desktop-hooks-stopped]"))
    return "工具未执行：内置钩子配置无法读取，本轮已停止。";
  if (text.includes(OPENING_STOPPED)) return "工具未执行：缺少开场说明，本轮已停止。";
  if (text.includes(OPENING_REQUIRED)) return "工具尚未执行，等待补充开场说明。";
  return null;
}
