import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** 声明仍是唯一配置事实；快照只用于比较启动时加载的内容。 */
export async function readPluginConfigSnapshot(root) {
  let entries;
  try {
    entries = await readdir(join(root, "plugins"), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { signature: "", files: new Map() };
    throw error;
  }
  const files = new Map(),
    parts = [];
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    for (const file of ["step.plugin.json", "step-user-config.json"]) {
      try {
        const content = await readFile(join(root, "plugins", entry.name, file), "utf8");
        files.set(entry.name + "/" + file, content);
        parts.push(entry.name, file, content);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return { signature: createHash("sha256").update(parts.join("\0")).digest("hex"), files };
}
export async function pluginConfigSignature(root) {
  return (await readPluginConfigSnapshot(root)).signature;
}

/** SDK 自己新增的 provision 声明已在启动时加载；真实并发修改不能被新基线吞掉。 */
export function resolveStartedPluginSignature(before, after) {
  for (const [file, content] of before.files)
    if (after.files.get(file) !== content) return before.signature;
  for (const [file, content] of after.files) {
    if (before.files.has(file)) continue;
    if (!file.endsWith("/step.plugin.json")) return before.signature;
    try {
      if (!JSON.parse(content.replace(/^\uFEFF/, "")).provision) return before.signature;
    } catch {
      return before.signature;
    }
  }
  return after.signature;
}
