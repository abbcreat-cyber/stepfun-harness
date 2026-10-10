import {
  encodeQuestionnaire,
  normalizeClarification,
  clarificationResult,
  desktopQuestionnaireParameters,
} from "../desktop-questionnaire.mjs";

/** 官方扩展钩子先于最终工具结果提交；RPC 模式必须等待桌面答案，不能沿 TUI-only 错误继续。 */
export default function desktopQuestionnaire(pi) {
  pi.on("session_start", (_event, context) => {
    if (context.mode !== "rpc" || typeof pi.registerTool !== "function") return;
    // 原生能力扩展在加载期也声明同名工具；session_start 后通过公开动态注册
    // 更新 RPC 声明和执行，避免加载冲突，复用现有 pending Map 与答案校验。
    // 不在 TUI 注册，避免改变终端原生问答；不依据题干猜测是否多选。
    pi.registerTool({
      name: "clarify_user",
      label: "AskUserQuestion",
      description: "Ask only when a genuine user-owned decision blocks progress. Supports one question or questions[], single choice, multiple choice (multiSelect=true), and free text. Waits for the user's answers before continuing.",
      parameters: desktopQuestionnaireParameters,
      executionMode: "sequential",
      async execute(toolCallId, input, _signal, _onUpdate, ctx) {
        const questions = normalizeClarification(input);
        const value = await ctx.ui.input(encodeQuestionnaire(toolCallId, input));
        return clarificationResult(questions, value === undefined ? undefined : JSON.parse(value));
      },
    });
  });
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
