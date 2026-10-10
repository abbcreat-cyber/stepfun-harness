/** 去掉模型在正文中重复泄漏的工具协议。代码示例保留，普通错误说明保留。 */
export function visibleAssistantText(text, { streaming = false, strip = true } = {}) {
  if (!strip) return text;
  const marker = "<tool_call>";
  // 普通正文不需要逐字重建。只有完整标记或流式末尾的未完标记才进入原解析器；
  // 代码块内的标记仍由原规则判断，不能用正则替换破坏示例。
  if (typeof text === "string" && !text.includes(marker)) {
    const tail = streaming ? text.lastIndexOf("<") : -1;
    if (tail < 0 || !marker.startsWith(text.slice(tail))) return text;
  }
  let output = "",
    i = 0,
    code = null;
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      code = code === "```" ? null : (code ?? "```");
      output += "```";
      i += 3;
      continue;
    }
    if (text[i] === "`" && code !== "```") {
      code = code === "`" ? null : "`";
      output += text[i++];
      continue;
    }
    if (!code && text.startsWith(marker, i)) {
      const end = text.indexOf("</tool_call>", i + marker.length);
      if (end === -1) break;
      i = end + "</tool_call>".length;
      continue;
    }
    if (!code && streaming && text[i] === "<" && marker.startsWith(text.slice(i))) break;
    output += text[i++];
  }
  return output;
}

/** 历史只在同一 response 确有结构化工具行时净化正文，不更改原生账本。 */
export function visibleConversationRows(rows) {
  const toolResponses = new Set(
    rows
      .filter((r) => r.kind === "toolCall" && r.assistantResponseId)
      .map((r) => r.assistantResponseId),
  );
  return rows
    .map((row) =>
      row.kind === "assistantText" && toolResponses.has(row.assistantResponseId)
        ? { ...row, text: visibleAssistantText(row.text ?? "") }
        : row,
    )
    .filter((row) => row.kind !== "assistantText" || row.text?.trim());
}
