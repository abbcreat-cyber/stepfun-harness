import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { commandPayloadSchemas } from "@zcode/shared/zcode-protocol-v4";

const MODEL_COMMANDS = new Set<CommandEnvelope["type"]>([
  "sendText",
  "sendGoalCommand",
  "switchModelConfig",
  "compact",
  "retryTurn",
  "editUserQuery",
  "sendQueuedNow",
  "resumeGoal",
  "resumeWorkflowRun",
  "startSavedWorkflow",
]);

/** 只拦截可能开始模型执行或修改模型连接的命令，取消/交互/只读控制通道独立。 */
export function requiresModelCommandAdmission(envelope: CommandEnvelope): boolean {
  if (MODEL_COMMANDS.has(envelope.type)) return true;
  if (envelope.type === "setAutoDrain")
    return commandPayloadSchemas.setAutoDrain.parse(envelope.payload).autoDrain;
  if (envelope.type === "createSession") {
    const { firstInput, config } = commandPayloadSchemas.createSession.parse(envelope.payload);
    return (
      firstInput !== undefined ||
      config?.modelSelection !== undefined ||
      config?.model !== undefined
    );
  }
  if (envelope.type === "createSelectionSideSession")
    return (
      commandPayloadSchemas.createSelectionSideSession.parse(envelope.payload).firstInput !==
      undefined
    );
  return false;
}

/** 取消只结束当前调用等待，不取消配置所有者的发布事务。 */
export async function awaitModelCommandAdmission(
  admit?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) {
    await admit?.();
    return;
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.resolve().then(() => admit?.()), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  signal.throwIfAborted();
}
