import { SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { searchResultDisplaySchema } from "@zcode/shared/zcode-protocol-v4";
import { TID_TOOL_SEARCH_RESULT } from "@zcode/shared";
import { getToolExecutionPhase } from "@/lib/executeGroupActivity.js";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockActions,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const SEARCH_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

import { getSearchPrimaryText, getSearchResultText } from "@/lib/searchToolPresentation.js";
export { getSearchPrimaryText } from "@/lib/searchToolPresentation.js";

export function SearchToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;
  const phase = getToolExecutionPhase(toolCall);
  const isRunning = context.isRunning && phase === "running";
  const searchPrimaryText = getSearchPrimaryText(
    intl,
    toolCall.input,
    toolCall.toolName ?? toolCall.kind,
  );
  const resultText = errorText ?? getSearchResultText(toolCall.output);
  const rawDisplay =
    typeof toolCall.raw === "object" && toolCall.raw !== null && "display" in toolCall.raw
      ? toolCall.raw.display
      : undefined;
  const parsedDisplay = searchResultDisplaySchema.safeParse(rawDisplay);
  const display = parsedDisplay.success ? parsedDisplay.data : undefined;
  const partialLabel = display?.timedOut
    ? "chat.toolCall.search.timedOut"
    : display?.truncated
      ? "chat.toolCall.search.partial"
      : display?.returnedCount === 0
        ? "chat.toolCall.search.empty"
        : undefined;
  const failedOrStopped = toolCall.status === "failed" || toolCall.status === "stopped";
  const renderContent = useCallback(
    () =>
      resultText === undefined ? null : (
        <CodeBlock
          code={resultText}
          language="text"
          enableSyntaxHighlighting={false}
          showLineNumbers={false}
          wrapLongLines
          contentClassName="max-h-60 overflow-auto scrollbar-hide"
          data-testid={TID_TOOL_SEARCH_RESULT}
          data-tool-id={toolCall.toolId}
        >
          <CodeBlockHeader showWrapButton={false}>
            <span className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.search.results" })}
            </span>
            <CodeBlockActions>
              <CodeBlockCopyButton
                title={intl.formatMessage({ id: "chat.toolCall.search.copyResults" })}
              />
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
      ),
    [intl, resultText, toolCall.toolId],
  );
  const primaryText = useMemo(
    () => <span className="truncate">{searchPrimaryText}</span>,
    [searchPrimaryText],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SEARCH_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={resultText !== undefined && (context.canToggle ?? true)}
        forceOpen={resultText !== undefined && (context.forceOpen ?? false)}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id:
              phase === "awaitingApproval"
                ? "chat.permission.awaitingApproval"
                : phase === "pending"
                  ? "chat.toolCall.status.pending"
                  : isRunning
                    ? "chat.toolCall.search.searching"
                    : "chat.toolCall.kind.search",
          })
        }
        sourceLabel={context.sourceLabel}
        // search 的主文本直接拼成一句完整摘要，不再拆 secondaryText；
        // 这样能避免 title 干扰，也更适合列表/目录查询这类操作。
        primaryText={primaryText}
        statusLabel={
          !failedOrStopped && partialLabel ? intl.formatMessage({ id: partialLabel }) : statusLabel
        }
        showStatusLabel={Boolean(partialLabel) || toolCall.status === "stopped"}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={toolCall.title}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
      {/* <pre>{JSON.stringify(toolCall, null, 2)}</pre> */}
    </>
  );
}
