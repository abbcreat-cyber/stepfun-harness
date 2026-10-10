/** 通知是否仍有新信息：等待状态由工作流持有，已读取的完成结果来自持久化工具回执。 */
export async function isWorkflowNoticeCurrent(ctx, notice) {
  if (!notice) return true;
  if (notice.status === "waiting_question")
    return ctx.workflowBridge.isQuestionPending(ctx.primarySession.sessionId, notice);
  if (notice.status !== "completed") return true;
  return !(ctx.conversationRows ?? []).some(row => {
    if (row.kind !== "toolCall" || row.toolName !== "GetWorkflowRun" || row.status !== "success" || row.input?.runId !== notice.runId) return false;
    try {
      const result = JSON.parse(row.output?.text);
      return result.run?.runId === notice.runId && result.run.status === "completed";
    } catch { return false; }
  });
}
