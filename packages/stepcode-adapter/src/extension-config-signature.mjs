import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { resolveStepRuntimePaths } from "./model-config-signatures.mjs";

/** 全局/项目扩展和本地文件 import 是 SDK 启动快照的一部分，不能只比较插件声明。 */
export async function extensionConfigSignature(env, cwd) {
  const { agentDir } = await resolveStepRuntimePaths(env);
  const files = new Map();
  let bytes = 0;
  async function visit(file) {
    let canonical, content;
    try {
      canonical = await realpath(file);
      if (files.has(canonical)) return;
      content = await readFile(canonical, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    bytes += Buffer.byteLength(content);
    if (files.size >= 512 || bytes > 16 * 1024 * 1024) throw new Error("扩展配置超出读取上限");
    files.set(canonical, content);
    for (const match of content.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      if (!/^(?:file:|\.\.?\/)/.test(match[1])) continue;
      const url = new URL(match[1], pathToFileURL(canonical));
      if (url.protocol === "file:") await visit(fileURLToPath(url));
    }
  }
  async function directory(path, depth = 0) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (depth > 8) throw new Error("扩展目录层级超出读取上限");
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const pathToEntry = join(path, entry.name);
      if (entry.isDirectory()) await directory(pathToEntry, depth + 1);
      else if (/\.(?:[cm]?js|ts|json)$/.test(entry.name)) await visit(pathToEntry);
    }
  }
  await directory(join(agentDir, "extensions"));
  await directory(join(resolve(cwd), ".stepcode", "extensions"));
  return createHash("sha256")
    .update(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
}
