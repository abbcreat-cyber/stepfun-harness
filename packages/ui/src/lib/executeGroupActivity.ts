interface ExecutionChild {
  toolCall: { status: string; raw?: unknown };
}

export function getToolExecutionPhase({
  status,
  raw,
}: ExecutionChild["toolCall"]): "running" | "awaitingApproval" | "pending" | "complete" {
  if (status !== "pending" && status !== "in_progress") return "complete";
  if (
    typeof raw === "object" &&
    raw !== null &&
    "v4Status" in raw &&
    raw.v4Status === "pendingApproval"
  )
    return "awaitingApproval";
  return status === "in_progress" ? "running" : "pending";
}

/** 只从子项事实派生摘要；最后一条待审批命令不能遮住前面仍在运行的命令。 */
export function getExecuteGroupActivity<T extends ExecutionChild>(
  children: readonly T[],
  active: boolean,
): {
  phase: ReturnType<typeof getToolExecutionPhase>;
  child?: T;
} {
  if (active) {
    for (const state of ["running", "awaitingApproval", "pending"] as const) {
      const child = children.findLast((item) => getToolExecutionPhase(item.toolCall) === state);
      if (child) return { phase: state, child };
    }
  }
  return { phase: "complete" };
}
