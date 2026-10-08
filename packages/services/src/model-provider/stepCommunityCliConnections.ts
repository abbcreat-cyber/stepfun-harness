import type { ModelSelectionView } from "@zcode/provider";
import { readStepConnectionKey } from "./stepCommunityApiKey.js";
import { STEP_API_PROVIDER_ID, STEP_PLAN_PROVIDER_ID, type StepEnvRecord } from "./stepCommunityModelSelection.js";
import type { StepCliCustomProviderEntry } from "./cliProviderSync.js";

/** 双通道复用现有 CLI models.json 加锁同步；密钥只在 host 内流向 CLI 凭据文件。 */
export function buildStepCommunityCliConnections(env: StepEnvRecord, view: ModelSelectionView): StepCliCustomProviderEntry[] {
  const entries: StepCliCustomProviderEntry[] = [];
  for (const [mode, providerId, baseUrl] of [
    ["api", STEP_API_PROVIDER_ID, "https://api.stepfun.com/v1"],
    ["subscription", STEP_PLAN_PROVIDER_ID, "https://api.stepfun.com/step_plan/v1"],
  ] as const) {
    const key = readStepConnectionKey(env, mode).key;
    const provider = view.providers.find(p => p.providerId === providerId);
    if (!key || !provider) continue;
    entries.push({ providerId, api: "openai-completions", baseUrl, apiKey: key,
      models: provider.models.map(m => ({ modelId: m.modelId, supportsImage: m.config.properties?.inputFormat?.supportsImage === true, reasoning: true, contextWindow: 256000, maxTokens: 256000 })) });
  }
  return entries;
}
