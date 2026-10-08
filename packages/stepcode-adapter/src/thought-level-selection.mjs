/** UI 二态与 SDK 档位不同，仅使用底座实际报告的档位，HTTP 参数由显式 map 处理。 */
export function resolveThoughtLevel(requested, levels, current) {
  const value = requested.trim().toLowerCase();
  if (value === "default") return undefined;
  const level = value === "disabled" ? "off" : value === "enabled"
    ? (current !== "off" && levels.includes(current) ? current : levels.includes("high") ? "high" : levels.find(item => item !== "off")) : value;
  if (!level || !levels.includes(level)) throw new Error(`不支持的思考档位: ${requested}（可用档位: ${levels.join(", ")}）`);
  return level;
}
