const tools = new Set(["search_files", "find_files", "list_directory"]);

/** 只读取原生结构化事实；条数等于上限并不能证明结果已被截断。 */
export function nativeSearchResultDisplay(toolName, result) {
  const d = result?.details;
  if (!tools.has(toolName) || !d || typeof d !== "object" || Array.isArray(d)) return null;
  const count = toolName === "search_files" ? d.matches : toolName === "list_directory" ? d.returnedEntries : undefined;
  const returnedCount = Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  if (returnedCount === undefined && typeof d.truncated !== "boolean" && typeof d.stepTruncated !== "boolean" && typeof d.timedOut !== "boolean") return null;
  return { kind: "search_result", truncated: d.truncated === true || d.stepTruncated === true, timedOut: d.timedOut === true,
    ...(returnedCount === undefined ? {} : { returnedCount }) };
}

export function nativeSearchResultNotice(event) {
  if (event.isError) return;
  const status = nativeSearchResultDisplay(event.toolName, event);
  if (!status || (!status.truncated && !status.timedOut)) return;
  const text = `[Native search result: ${status.timedOut ? "timed out" : "truncated"}. These results are partial, not exhaustive. Narrow the scope or adjust the tool limit only if the task needs it.]`;
  if (event.content?.some(part => part.type === "text" && part.text === text)) return;
  return { content: [...(event.content ?? []), { type: "text", text }] };
}
