import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join, delimiter, isAbsolute } from "node:path";

export function isMissingBundledPlugin(manifest, env = process.env, exists = existsSync) {
  // 只识别底座自动种下的 StepPage 声明，不碰用户自定义 MCP。
  if (manifest?.id !== "steppage" || manifest.provision?.installer !== "steppageInstaller") return false;
  const command = manifest.mcpServers?.steppage?.command;
  if (typeof command !== "string") return true;
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const candidates = isAbsolute(command) ? [command] : path.split(delimiter).filter(Boolean).map(dir => join(dir.replace(/^"|"$/g, ""), command));
  return !candidates.some(file => ["", ...(process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [])].some(ext => exists(file + ext)));
}

/** 原生预装只写声明、不带可执行文件；缺失时同时退役声明与自动补装入口。调用方持插件锁。 */
export async function retireMissingBundledPlugins(root) {
  const builtIn = { id: "steppage", provision: { installer: "steppageInstaller" }, mcpServers: { steppage: { command: "steppage-mcp" } } };
  if (!isMissingBundledPlugin(builtIn)) return;
  const plugins = join(root, "plugins");
  await mkdir(plugins, { recursive: true });
  const marker = join(plugins, ".stepcode-preinstalled");
  const previous = await readFile(marker, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  if (!Array.isArray(previous)) throw new Error("Invalid native plugin preinstall marker");
  if (!previous.includes("steppage")) await writeFile(marker, JSON.stringify([...previous, "steppage"]));
  const file = join(plugins, "steppage", "step.plugin.json");
  const current = await readFile(file, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (current && isMissingBundledPlugin(current)) await rename(file, join(plugins, "steppage", "step.plugin.disabled.json"));
}
