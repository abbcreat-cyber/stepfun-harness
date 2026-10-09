import { Loader2 } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DraftSendPreview } from "./composer/draftSendPreview.js";
import { countComposerPromptContexts, parseComposerPromptContexts } from "./composer/composerPromptContexts.js";

export function ConversationDraftSendPreview({ preview, workspacePath, workspaceIdentity }: { preview: DraftSendPreview; workspacePath: string; workspaceIdentity?: string }) {
  const { locale } = useZCodeIntl();
  const chinese = locale.startsWith("zh");
  const parsed = parseComposerPromptContexts(preview.text, { workspacePath, workspaceIdentity });
  const attachmentCount = preview.attachmentCount + countComposerPromptContexts(parsed);
  return (
    <div data-testid="v4-draft-send-preview" className="flex flex-col items-end gap-2 py-6" aria-live="polite">
      <div className="max-w-full whitespace-pre-wrap break-words rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl">
        {parsed.visibleContent}
        {attachmentCount > 0 ? <div className="mt-2 text-ui-caption text-foreground-subtle">{chinese ? `附件 ${attachmentCount}` : `${attachmentCount} attachment(s)`}</div> : null}
      </div>
      <div className="flex items-center gap-2 text-ui-caption text-foreground-subtle">
        <Loader2 className="size-3 motion-safe:animate-spin" />
        {chinese ? "正在发送…" : "Sending…"}
      </div>
    </div>
  );
}
