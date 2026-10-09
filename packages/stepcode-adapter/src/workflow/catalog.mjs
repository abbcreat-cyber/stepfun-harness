export const workflowSlashCommands = [
  {
    name: "workflow",
    description: "创建可确认、可追踪的多步骤工作流",
    inputHint: "描述要完成的工作",
    source: "builtin",
  },
];
const names = new Set([
  "ReadWorkflowGuide",
  "CreateWorkflow",
  "GetWorkflowRun",
  "ListWorkflowRuns",
  "CancelWorkflowRun",
  "ResumeWorkflowRun",
  "SaveWorkflow",
  "ListSavedWorkflows",
  "EvalWorkflowSnippet",
  "AmendWorkflow",
  "ResolveWorkflowQuestion",
]);
const actorReadMethods = new Set([
  "session/read", "session/subscribe", "v4/conversation/subscribe", "v4/conversation/unsubscribe",
  "v4/conversation/resync", "v4/conversation/rows", "v4/conversation/attachmentRead",
  "v4/attachment/read", "v4/attachment/previewSource", "v4/conversation/plans", "v4/commands/query",
]);
export const isWorkflowActorReadMethod = method => actorReadMethods.has(method);
export function workflowToolName(name) {
  if (names.has(name)) return name;
  // 仅规范本插件的名称，避免其他 MCP 同名工具被误认成工作流。
  if (typeof name === "string" && name.startsWith("step_workflows__step_workflows__")) {
    const tail = name.split("__").at(-1);
    if (names.has(tail)) return tail;
  }
  return name;
}
export function expandWorkflowCommand(text) {
  return /^\/workflow(?:\s|$)/.test(text)
    ? `请使用原 ZCode 工作流机制完成以下任务。先用一句中文说明计划；如果当前会话未读过指南，调用 ReadWorkflowGuide 完整原版一次。按原技能的真实依赖和并行 join 规则编写脚本，再调用 CreateWorkflow 展示确认图，等待用户批准。不要把连续 await 的脚本说成并行，不要用命令行绕过确认执行。\n${text.replace(/^\/workflow\s*/, "")}`
    : text;
}
export function delegatesWorkflowApproval(request) {
  return (
    request.method === "confirm" &&
    /^Approve step_workflows__step_workflows__(CreateWorkflow|ResumeWorkflowRun|EvalWorkflowSnippet|AmendWorkflow) \[[^\]]+\]$/.test(
      request.title ?? "",
    )
  );
}
