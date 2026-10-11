import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

export function NativeShellOutputDetails({
  display,
  onOpen,
}: {
  display?: { truncated: boolean; outputPath?: string };
  onOpen?: (source: CodeViewerSource) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!display || (!display.truncated && !display.outputPath)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-ui-caption text-foreground-subtle">
      {display.truncated ? (
        <span>{intl.formatMessage({ id: "chat.toolCall.execute.truncated" })}</span>
      ) : null}
      {display.outputPath && onOpen ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            onOpen({
              type: "file",
              path: display.outputPath!,
              title: intl.formatMessage({ id: "chat.toolCall.execute.fullOutput" }),
            })
          }
        >
          {intl.formatMessage({ id: "chat.toolCall.execute.fullOutput" })}
        </Button>
      ) : null}
    </div>
  );
}
