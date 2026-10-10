import type { IModelSelectionService } from "@zcode/services";
import type { ModelSelection } from "@zcode/shared";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

/** 从目标 Host 解析有效模型，复用普通发送校验，不能回退硬编码的供应商。 */
export async function resolveSavedWorkflowLaunchSelection(
  service: Pick<IModelSelectionService, "getView">,
  recent: ModelSelection | undefined,
): Promise<ModelSelection> {
  const intent = recent ?? (await service.getView()).preferredSelection;
  if (!intent) throw new Error("Please configure an available model before running the workflow.");
  const view = await service.getView({ selection: intent });
  const config = createComposerSubmissionConfig({ mode: "build", modelSelection: view.effectiveSelection ?? undefined }, view);
  if (!config) throw new Error("The selected workflow model is unavailable. Please select an available model.");
  return config.modelSelection;
}
