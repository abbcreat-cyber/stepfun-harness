/** 仅用于新 session worker 的冷历史：磁盘上的 running 不代表仍有执行者。 */
export function settleInterruptedHistory(saved) {
  if (!saved || saved.session?.readOnly || !Array.isArray(saved.rows)) return saved;
  const lastEvidence = new Map();
  for (const row of saved.rows) {
    const at = row.endedAt ?? row.createdAt;
    if (Number.isFinite(at)) lastEvidence.set(row.turnId, Math.max(lastEvidence.get(row.turnId) ?? 0, at));
  }
  for (const row of saved.rows) {
    if (row.kind === "turnHeader" && row.state === "running") {
      row.state = "completedInterrupted";
      row.endedAt = lastEvidence.get(row.turnId) ?? row.startedAt ?? row.createdAt;
      row.activeMs = Math.max(0, row.endedAt - (row.startedAt ?? row.endedAt));
    }
    if (row.kind === "toolCall" && ["running", "inputStreaming", "pendingApproval"].includes(row.status)) {
      row.status = row.error ? "error" : "cancelled";
      delete row.interactionId;
    }
    if (row.state === "streaming") row.state = "interrupted";
  }
  return saved;
}
