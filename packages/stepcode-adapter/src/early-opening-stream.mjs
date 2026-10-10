import { meaningfulOpening } from "./assistant-opening-hook.mjs";

export function openingTaskText(context) {
  if (!context.systemPrompt?.includes("<desktop_opening_timing>")) return null;
  const message = context.messages.findLast((m) => m.role === "user");
  const text =
    typeof message?.content === "string"
      ? message.content
      : (message?.content ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
  if (text.startsWith("工作流状态通知：")) return null;
  if (
    !/(?:画|绘制|制作|生成|创建|修改|修复|优化|安装|读取|检查|分析|整理|搜索|查找|测试|实现|构建|开发|写|删除|打开|运行|继续|帮我|\b(?:build|create|write|fix|debug|implement|review|analy[sz]e|draw|optimi[sz]e|run|test|search|read|open|delete|install|update|continue)\b)/i.test(
      text,
    )
  )
    return null;
  return text.slice(0, 4000);
}

function addUsage(a, b) {
  const value = { ...a };
  for (const [key, n] of Object.entries(b ?? {})) {
    if (typeof n === "number") value[key] = (Number.isFinite(value[key]) ? value[key] : 0) + n;
    else if (n && typeof n === "object") value[key] = addUsage(value[key], n);
  }
  return value;
}

/** 同一原生 agent 轮次中的有界开场请求；只拼接实际生成的正文，不解析 SSE 或执行工具。 */
export function earlyOpeningStream({
  createStream,
  model,
  context,
  options,
  startOpening,
  startMain,
  timeoutMs = 8000,
}) {
  const output = createStream();
  void (async () => {
    let opening,
      prefix = [],
      published = false;
    const empty = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const merged = (message) => ({
      ...message,
      content: [...prefix, ...message.content],
      usage: addUsage(message.usage, opening?.usage),
    });
    try {
      options.signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("Opening deadline")), timeoutMs);
      let rejectAbort;
      const cancelled = new Promise((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason ?? new Error("Opening cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      try {
        opening = await Promise.race([startOpening(controller.signal).result(), cancelled]);
      } catch {
        // 开场最多尝试一次；失败或超时继续原任务，用户取消则在下面直接结束，不能偷偷续跑。
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", rejectAbort);
        options.signal?.removeEventListener("abort", abort);
      }
      options.signal?.throwIfAborted();
      const text = (opening?.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim();
      if (
        opening?.stopReason === "stop" &&
        text.length <= 240 &&
        !/```|<svg|<tool_call/i.test(text) &&
        meaningfulOpening(text)
      ) {
        prefix = [{ type: "text", text }];
        const partial = { ...empty, content: prefix, usage: opening.usage };
        output.push({ type: "start", partial });
        output.push({ type: "text_start", contentIndex: 0, partial });
        output.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
        output.push({ type: "text_end", contentIndex: 0, content: text, partial });
        published = true;
      }
      const mainContext = prefix.length
        ? {
            ...context,
            systemPrompt:
              context.systemPrompt +
              `\n本轮已向用户发出开场说明：${JSON.stringify(text)}。现在直接继续实际分析和执行，不重复开场；不得把这句计划当成已完成事实。`,
          }
        : context;
      options.signal?.throwIfAborted();
      for await (const event of startMain(mainContext)) {
        if (event.type === "start" && published) continue;
        if (event.type === "done") {
          output.push({ ...event, message: merged(event.message) });
          return;
        }
        if (event.type === "error") {
          output.push({ ...event, error: merged(event.error) });
          return;
        }
        output.push({
          ...event,
          ...(event.partial ? { partial: merged(event.partial) } : {}),
          ...(event.contentIndex !== undefined
            ? { contentIndex: event.contentIndex + prefix.length }
            : {}),
        });
      }
      throw new Error("Provider stream ended without terminal event");
    } catch (error) {
      const aborted = options.signal?.aborted;
      output.push({
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: {
          ...merged(empty),
          stopReason: aborted ? "aborted" : "error",
          errorMessage: aborted ? "Request cancelled" : error.message,
        },
      });
    }
  })();
  return output;
}
