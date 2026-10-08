import { resolveStepRuntimePaths } from "../model-config-signatures.mjs";
import { isAbsolute } from "node:path";

let workspaceContract;

/** 创建/恢复与准入共用一个身份解析，logical key 不能当成 SDK 文件路径。 */
export async function resolveSessionWorkspace(ctx, { workspaceId, workspace } = {}) {
  const env = ctx.options.stepEnv ?? process.env;
  await resolveStepRuntimePaths(env);
  workspaceContract ??= import("@zcode/shared");
  const { resolveWorkspaceKey } = await workspaceContract;
  let initial;
  if (env.STEPCODE_HOST_WORKSPACE_REF) {
    try { initial = JSON.parse(env.STEPCODE_HOST_WORKSPACE_REF); }
    catch { throw new Error("Host 工作区身份不可读取"); }
    if (!initial || typeof initial.workspacePath !== "string" || !isAbsolute(initial.workspacePath)) throw new Error("Host 工作区物理路径无效");
  }
  const source = workspace ?? {};
  const requested = workspaceId?.trim() || source.workspaceIdentity?.trim() || source.workspaceKey?.trim();
  if (initial) {
    const identity = initial.workspaceIdentity?.trim() || (initial.workspaceKey && initial.workspaceKey !== initial.workspacePath ? initial.workspaceKey : undefined);
    const key = resolveWorkspaceKey({ workspacePath: initial.workspacePath, workspaceIdentity: identity });
    const suppliedKey = requested || (source.workspacePath && source.workspacePath !== initial.workspacePath ? resolveWorkspaceKey(source) : key);
    if (suppliedKey !== key) throw new Error("工作区身份与 Host 绑定不匹配");
    if (initial.remoteSessionId && source.remoteSessionId && initial.remoteSessionId !== source.remoteSessionId) throw new Error("远程会话与 Host 绑定不匹配");
    const remoteSessionId = initial.remoteSessionId || source.remoteSessionId;
    return { workspacePath: initial.workspacePath, workspaceKey: key, ...(identity ? { workspaceIdentity: identity } : {}), ...(remoteSessionId ? { remoteSessionId } : {}) };
  }
  const candidatePath = source.workspacePath || (workspaceId && isAbsolute(workspaceId) ? workspaceId : undefined);
  if (source.workspaceIdentity && (!candidatePath || !isAbsolute(candidatePath))) throw new Error("工作区身份缺少可信物理路径");
  const workspacePath = candidatePath && isAbsolute(candidatePath) ? candidatePath : ctx.options.stepCwd || process.cwd();
  const identity = source.workspaceIdentity?.trim() || (requested && requested !== workspacePath ? requested : undefined);
  return { workspacePath, workspaceKey: resolveWorkspaceKey({ workspacePath, workspaceIdentity: identity }),
    ...(identity ? { workspaceIdentity: identity } : {}), ...(source.remoteSessionId ? { remoteSessionId: source.remoteSessionId } : {}) };
}

/** 新轮准入只问 Host 的 Registry/投影 barrier，不查询本 Agent，不另存同步状态。 */
export async function assertHostModelAdmission(ctx, { sessionId, workspace, selection } = {}) {
  const env = ctx.options.stepEnv ?? process.env;
  if (env.STEPCODE_HOST_MODEL_ADMISSION !== "1") return;
  if (typeof ctx.requestHost !== "function") throw new Error("模型执行准入口不可用");
  const id = sessionId ?? ctx.primarySession?.sessionId ?? "workspace-control";
  const saved = ctx.primarySession?.sessionId === id ? ctx.primarySession : ctx.readConversation?.(id)?.session;
  const reference = await resolveSessionWorkspace(ctx, { workspace: workspace ?? saved?.workspace });
  const result = await ctx.requestHost("interaction/prepareModelExecution", { workspace: reference, sessionId: id,
    ...(selection ? { selection: { providerId: selection.providerId, modelId: selection.modelId } } : {}) });
  if (result?.ready !== true) throw Object.assign(new Error(result?.error?.message || "模型配置尚未同步，执行已阻止"), { code: result?.error?.code || "model_admission_unavailable" });
}
