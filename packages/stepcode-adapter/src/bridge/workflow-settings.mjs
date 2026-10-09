import { makeCommandAck, makeToolCallRow, makeTurnHeaderRow, nextId } from "../wire-shapes.mjs";

/** GUI 点击 Apply 是本次设置变更的授权；沿用工作流 service，不另开模型轮。 */
export async function amendWorkflowSettings(ctx, envelope, revisionAtDecision) {
  const { commandId, sessionId } = envelope;
  const reject = (reason, message) => ({ commandId, revisionAtDecision, status: "rejected",
    reasonCode: `fault.command.workflowRunSettingsRejected.${reason}`, ...(message ? { message } : {}) });
  try {
    if (sessionId !== ctx.primarySession?.sessionId) await ctx.restoreSession(sessionId);
    const service = await ctx.workflowBridge.service(sessionId);
    const { amendWorkflowRunSettingsPayloadSchema } = await import("@zcode/shared/zcode-protocol-v4");
    const payload = amendWorkflowRunSettingsPayloadSchema.parse(envelope.payload);
    let record;
    try { record = service.assertRun(payload.workId); } catch { return reject("not_found"); }
    if (service.refresh().runs.find(run => run.runId === record.runId)?.supersededBy) return reject("not_configurable");
    if (!["pending", "running", "stopped", "errored"].includes(record.status) || record.stopReason === "superseded") return reject("not_configurable");
    if (payload.subagentModel === undefined && payload.maxConcurrency === undefined) return reject("unchanged");
    const input = { run_id: record.runId,
      ...(payload.subagentModel !== undefined ? { subagent_model: payload.subagentModel } : {}),
      ...(payload.maxConcurrency !== undefined ? { max_concurrency: payload.maxConcurrency === null ? null : Math.min(8, payload.maxConcurrency) } : {}),
    };
    const toolCallId = nextId("settings");
    const result = await service.amend(input, toolCallId, {}, { fromSettings: true });
    if (!result.ok) return reject(result.reason === "script_unchanged" ? "unchanged" : result.reason === "missing_boundaries" ? "missing_boundaries" : "compile_failed", result.message);
    const turnId = ctx.turnBusy && ctx.currentTurnId ? ctx.currentTurnId : nextId("workflow-settings-turn");
    if (!ctx.turnBusy) ctx.conversationRows.push(makeTurnHeaderRow({ rowId: ctx.nextRowId(), turnId, state: "completedSuccess" }));
    ctx.conversationRows.push({ ...makeToolCallRow({ rowId: ctx.nextRowId(), turnId, toolCallId, toolName: "AmendWorkflow", inputText: JSON.stringify(input) }),
      input, display: result.display, output: { text: JSON.stringify(result) }, status: "success" });
    ctx.persistConversation();ctx.broadcastConversationSnapshot();
    return makeCommandAck({ commandId, revisionAtDecision, result: { type: "amendWorkflowRunSettings", runId: result.runId, toolCallId,
      ...(result.supersedes ? { supersededRunId: result.supersedes } : {}) } });
  } catch (error) { return reject(/model|模型|思考/i.test(error.message) ? "model_unavailable" : "start_failed", error.message); }
}
