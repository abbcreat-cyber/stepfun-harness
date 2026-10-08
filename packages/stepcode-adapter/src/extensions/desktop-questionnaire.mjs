import {
  encodeQuestionnaire,
  normalizeClarification,
  clarificationResult,
} from "../desktop-questionnaire.mjs";

/** 官方扩展钩子先于最终工具结果提交；RPC 模式必须等待桌面答案，不能沿 TUI-only 错误继续。 */
export default function desktopQuestionnaire(pi) {
  pi.on("tool_result", async (event, ctx) => {
    if (ctx.mode !== "rpc" || event.toolName !== "clarify_user") return;
    // 更新后的底座若已原生完成 RPC 提问，不再补问第二次，也不重问已取消的问题。
    if (
      !event.content?.some(
        (part) => part.type === "text" && /clarify_user requires an interactive UI/.test(part.text),
      )
    )
      return;
    const questions = normalizeClarification(event.input);
    const value = await ctx.ui.input(encodeQuestionnaire(event.toolCallId, event.input));
    return clarificationResult(questions, value === undefined ? undefined : JSON.parse(value));
  });
}
