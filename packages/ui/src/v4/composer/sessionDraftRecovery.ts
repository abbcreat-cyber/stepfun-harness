import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { V4ComposerDraft } from "./composerDraftStore.js";

/** 旧适配器快照缺 modelSelection 时会持久化空模型；只补回同一会话的确切选择。 */
export function recoverSessionDraftSelection(
  draft: V4ComposerDraft,
  sessionConfig: Partial<SessionConfigState> | null | undefined,
): V4ComposerDraft {
  if (draft.modelSelection || !sessionConfig?.modelSelection) return draft;
  return { ...draft, modelSelection: sessionConfig.modelSelection };
}
