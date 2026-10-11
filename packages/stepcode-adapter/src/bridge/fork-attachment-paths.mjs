/** 只改已知私有附件路径；原生工具参数、JSON 文本及前端投影使用同一套映射。 */
export function attachmentPathRemapper(replacements) {
  const variants = new Map();
  for (const [from, to] of replacements) {
    variants.set(from, to);
    variants.set(JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1));
    if (process.platform === "win32") variants.set(from.replaceAll("\\", "/"), to.replaceAll("\\", "/"));
  }
  const rules = [...variants].sort((a, b) => b[0].length - a[0].length).map(([from, to]) => {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 不能把 .txt.backup 等同前缀文件也搬到子会话；允许正文、Markdown 和 JSON 的边界。
    return [new RegExp(`(?<![\\p{L}\\p{N}_:.-])${escaped}(?=$|[\\s"'\x60\\]\\[(){}<>,;])`, process.platform === "win32" ? "giu" : "gu"), to];
  });
  function remap(value) {
    if (typeof value === "string") {
      for (const [pattern, to] of rules) value = value.replace(pattern, () => to);
      return value;
    }
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    return value;
  }
  return remap;
}
