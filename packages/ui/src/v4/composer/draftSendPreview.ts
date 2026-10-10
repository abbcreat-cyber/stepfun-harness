import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

export interface DraftSendPreview {
  token: number;
  workspaceKey: string;
  generation: number;
  text: string;
  attachmentCount: number;
  sessionId: string | null;
  commandId: string | null;
}

export function shouldPreviewPendingSend(text: string, draftMode: boolean, inputRoutingMode?: string | null, requestedDelivery?: string) {
  return !text.trimStart().startsWith("/") && (draftMode || inputRoutingMode === "startNow" || requestedDelivery === "startNow");
}

/** 本次提交的本地等待态；权威消息接替后不再渲染，不能作为 accepted 输入。 */
export function visibleDraftSendPreview(
  preview: DraftSendPreview | null,
  workspaceKey: string,
  generation: number,
  sessionId: string | null,
  snapshot: (Pick<ConversationSnapshot, "sessionId"> & { rows: Pick<ConversationSnapshot["rows"], "window"> }) | null,
): DraftSendPreview | null {
  if (!preview || preview.workspaceKey !== workspaceKey) return null;
  if (sessionId === null ? preview.generation !== generation : preview.sessionId !== sessionId)
    return null;
  if (snapshot?.sessionId === preview.sessionId && preview.commandId &&
    snapshot.rows.window.some(row => row.kind === "userInput" && row.sourceCommandId === preview.commandId))
    return null;
  return preview;
}
