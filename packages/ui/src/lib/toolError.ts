import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFirstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readNonEmptyString(record[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```[\w-]*\n?([\s\S]*?)\n?```$/);
  return fencedMatch?.[1]?.trim() ?? trimmed;
}

export function normalizeWrappedErrorText(text: string): string {
  const unwrappedFenceText = stripMarkdownCodeFence(text);
  const wrappedErrorMatch = unwrappedFenceText.match(
    /^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/i,
  );

  return wrappedErrorMatch?.[1]?.trim() || unwrappedFenceText;
}

function readTaggedToolErrorText(value: unknown): string | undefined {
  const text = readNonEmptyString(value);
  if (!text || !/<tool_use_error>[\s\S]*<\/tool_use_error>/i.test(text)) {
    return undefined;
  }

  return normalizeWrappedErrorText(text);
}

export function getToolCallErrorText(
  toolCall: Pick<ChatToolCall, "error" | "output" | "raw" | "status">,
): string | undefined {
  const directError = readNonEmptyString(toolCall.error);
  if (directError) {
    return directError;
  }
  // 失败终态或明确 error 才是错误依据；成功正文里的 message 或标签可能只是文档内容。
  const failed = toolCall.status === "failed";

  if (isRecord(toolCall.output)) {
    const outputError = readFirstStringField(
      toolCall.output,
      failed ? ["error", "message", "text", "content"] : ["error"],
    );
    if (outputError) {
      return failed ? normalizeWrappedErrorText(outputError) : outputError;
    }
  }

  const taggedOutputError = failed ? readTaggedToolErrorText(toolCall.output) : undefined;
  if (taggedOutputError) {
    return taggedOutputError;
  }
  if (failed && typeof toolCall.output === "string" && toolCall.output.trim())
    return normalizeWrappedErrorText(toolCall.output);

  if (!isRecord(toolCall.raw)) {
    return undefined;
  }

  const rawOutput = isRecord(toolCall.raw.rawOutput) ? toolCall.raw.rawOutput : null;
  const rawOutputError = rawOutput
    ? readFirstStringField(rawOutput, failed ? ["error", "message", "text", "content"] : ["error"])
    : undefined;
  if (rawOutputError) {
    return failed ? normalizeWrappedErrorText(rawOutputError) : rawOutputError;
  }

  const taggedRawOutputError = failed ? readTaggedToolErrorText(toolCall.raw.rawOutput) : undefined;
  if (taggedRawOutputError) {
    return taggedRawOutputError;
  }

  if (failed && typeof toolCall.raw.rawOutput === "string" && toolCall.raw.rawOutput.trim())
    return normalizeWrappedErrorText(toolCall.raw.rawOutput);

  if (failed) {
    const contentBlocks = Array.isArray(toolCall.raw.content) ? toolCall.raw.content : [];
    for (const block of contentBlocks) {
      if (!isRecord(block)) {
        continue;
      }

      const nestedContent = isRecord(block.content) ? block.content : null;
      const blockError = nestedContent
        ? readFirstStringField(nestedContent, ["error", "message", "text"])
        : readFirstStringField(block, ["error", "message", "text"]);
      if (blockError) {
        return normalizeWrappedErrorText(blockError);
      }
    }
  }

  return undefined;
}
