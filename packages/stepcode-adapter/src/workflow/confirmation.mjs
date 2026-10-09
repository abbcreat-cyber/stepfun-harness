import { randomUUID } from "node:crypto";

export function confirmWorkflow(options, pending, sessionId, request) {
  const row = options.rows(sessionId).find(row => row.toolCallId === request.toolCallId);
  const signal = request.signal;
  if (!row || !["running", "pendingApproval"].includes(row.status) || signal?.aborted)
    return Promise.resolve({ approved: false, feedback: "工具调用已结束，未执行" });
  // 片段中的命令是普通工具授权；不能在完全访问下另建无人处理的隐形等待。
  // 持久工作流仍保留原有的脚本确认图，不把业务确认当作命令权限放行。
  if (request.toolName === "EvalWorkflowSnippet") {
    const mode = options.session(sessionId)?.mode;
    if (mode === "yolo") return Promise.resolve({ approved: true });
    if (mode === "plan") return Promise.resolve({ approved: false });
  }
  return new Promise(resolve => {
    const interactionId = `workflow-confirm-${randomUUID()}`;
    let settled = false;
    const finish = decision => {
      if (settled) return;
      settled = true;
      pending.delete(interactionId);
      signal?.removeEventListener("abort", abort);
      // 工具超时后的迟到答复不能覆盖真实 error/success 终态。
      if (row.interactionId === interactionId) {
        delete row.interactionId;
        if (row.status === "pendingApproval") row.status = decision.approved ? "running" : "cancelled";
        else decision = { approved: false, feedback: "工具调用已结束，未执行" };
      } else decision = { approved: false, feedback: "工具调用已结束，未执行" };
      resolve(decision);
      options.changed(sessionId);
    };
    const abort = () => finish({ approved: false, feedback: "片段等待已取消或超时" });
    row.display = request.display;
    row.status = "pendingApproval";
    row.interactionId = interactionId;
    pending.set(interactionId, {
      sessionId, workflowConfirmation: true, resolve: finish,
      item: {
        interactionId, kind: "permission", anchorRowId: row.rowId, createdAt: Date.now(),
        payload: {
          kind: "permission", toolCallId: request.toolCallId,
          toolName: request.toolName ?? "CreateWorkflow",
          summary: request.toolName === "EvalWorkflowSnippet" ? "确认执行工作流片段中的命令" : "确认运行工作流",
          detail: request.input, display: request.display, freeText: true,
          options: [{ optionId: "allow", label: "运行", kind: "allowOnce" }, { optionId: "deny", label: "拒绝", kind: "deny" }],
        },
      },
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else options.changed(sessionId);
  });
}

export function discardFinishedConfirmations(options, pending, sessionId) {
  for (const request of pending.values()) {
    if (request.sessionId !== sessionId || !request.workflowConfirmation) continue;
    const row = options.rows(sessionId).find(row => row.toolCallId === request.item.payload.toolCallId);
    if (!row || row.status !== "pendingApproval") request.resolve({ approved: false });
  }
}
