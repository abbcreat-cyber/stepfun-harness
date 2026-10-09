import { StepCodeRpcClient } from "../rpc-client.mjs";
import { hasMappedProviderOptions, prepareProviderRequestOptions, discardProviderRequestOptions } from "../provider-request-options.mjs";
import { resolveThoughtLevel } from "../thought-level-selection.mjs";
import { parseModelPickerValue } from "./dependencies.mjs";

export function persistedWorkflowModel(service, runId) {
  return service.journal.listEvents(runId).find(item => item.event.type === "run-launched")?.event.subagentModel;
}

/** 复用原 picker 协议；只在独立 client 预检，不切换父会话、不调用模型。 */
export async function resolveWorkflowModel(service, requested) {
  const parent = service.options.getModel?.() ?? service.options.model;
  if (requested == null) return structuredClone(parent);
  const parsed = parseModelPickerValue(requested);
  const selection = !parsed.options && parsed.providerId === parent.providerId && parsed.modelId === parent.modelId
    ? { ...parsed, ...(parent.options ? { options: parent.options } : {}) } : parsed;
  if (service.options.validateModelSelection) {
    await service.options.validateModelSelection(selection);return structuredClone(selection);
  }
  await service.options.prepareModelExecution?.(selection);
  const client = new StepCodeRpcClient({
    command: [...service.options.command, "--no-session", "--no-tools"], cwd: service.options.cwd,
    env: service.options.getClientEnvironment ? await service.options.getClientEnvironment() : service.options.env,
    communicationMode: service.options.communicationMode, requestTimeoutMs: 15000,
  });
  try {
    await client.start();await client.setModel(selection.providerId, selection.modelId);
    const policy = await hasMappedProviderOptions(client, selection);
    if (selection.options?.reasoningLevel && !policy.reasoningMapped) {
      const level = resolveThoughtLevel(selection.options.reasoningLevel, await client.getAvailableThinkingLevels(), (await client.getState()).thinkingLevel);
      if (level) await client.setThinkingLevel(level);
    }
    const requestId = "workflow-model-preflight";
    await prepareProviderRequestOptions(client, { ...selection, requestId });
    await discardProviderRequestOptions(client, { ...selection, requestId });
  } finally { await client.stop(); }
  return structuredClone(selection);
}
