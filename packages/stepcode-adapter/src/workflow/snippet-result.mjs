/** 描述元数据独立于执行参数，兼容标题不能演变成放宽全部校验。 */
export function validateSnippetMetadata(input) {
  for (const key of Object.keys(input)) {
    if (!["code", "path", "timeoutMs", "title"].includes(key)) throw new Error(`未知工作流片段参数：${key}`);
  }
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 160))
    throw new Error("title 必须是最多 160 字符的描述文本");
}

export function snippetResult(result, startedAt) {
  const diagnostics = result.diagnostics ?? [];
  const logs = result.logs ?? [];
  const durationMs = Math.max(0, Date.now() - startedAt);
  const response = result.ok
    ? `The snippet completed in ${durationMs}ms.\n${result.artifact === undefined ? "It returned no value." : `Return value:\n${JSON.stringify(result.artifact, null, 2)}`}`
    : diagnostics.length ? diagnostics.map(d => `L${d.line}:C${d.column} ${d.message}`).join("\n")
      : result.error?.message || (result.status === "denied" ? "片段未获授权，未执行。" : result.status === "cancelled" ? "片段已取消。" : "片段执行失败。");
  return { ...result, diagnostics, logs, response, durationMs };
}

/** 与原版 display 上限一致；不加载工作流编译器，普通聊天不承担初始化开销。 */
export function snippetDisplay(toolName, text) {
  if (toolName !== "EvalWorkflowSnippet") return undefined;
  let result;
  try { result = JSON.parse(text); } catch { return undefined; }
  if (typeof result?.ok !== "boolean" || typeof result.response !== "string" ||
    !Number.isInteger(result.durationMs) || result.durationMs < 0 ||
    !Array.isArray(result.diagnostics) || !Array.isArray(result.logs)) return undefined;
  if (result.logs.some(line => typeof line !== "string") || result.diagnostics.some(d =>
    !d || ![d.line, d.column, d.code].every(n => Number.isInteger(n) && n >= 0) ||
    typeof d.message !== "string" || !d.message)) return undefined;
  let truncated = result.logsTruncated === true;
  const bound = (value, max) => { if (value.length > max) truncated = true; return value.slice(0, max); };
  const diagnostics = result.diagnostics.slice(0, 100).map(d => ({ line: d.line, column: d.column, code: d.code, message: bound(d.message, 2048) }));
  if (result.diagnostics.length > 100 || result.logs.length > 40) truncated = true;
  const logs = result.logs.slice(-40).map(line => bound(line, 1024));
  const response = bound(result.response, 4000);
  return { kind: "eval_workflow_snippet", ok: result.ok, diagnostics, logs, response, durationMs: result.durationMs, ...(truncated ? { truncated: true } : {}) };
}
