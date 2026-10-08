import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function publicMcpStatus(status = {}) {
  return Object.fromEntries(
    [
      "status",
      "transport",
      "toolCount",
      "updatedAt",
      "error",
      "failureKind",
      "serverRequestId",
      "protocolEra",
    ]
      .filter((key) => status[key] !== undefined)
      .map((key) => [key, status[key]]),
  );
}
export async function recordPluginRuntimeStatus(root, pid, pluginId, name, status) {
  const directory = join(root, "mcp-status");
  await mkdir(directory, { recursive: true });
  const key = createHash("sha256").update(`${pluginId}:${name}`).digest("hex").slice(0, 20);
  await writeFile(
    join(directory, `${pid}-${key}.json`),
    JSON.stringify({ pid, pluginId, name, status: publicMcpStatus(status) }),
  );
}
export async function readPluginRuntimeStatuses(root) {
  const statuses = {};
  let files;
  try {
    files = await readdir(join(root, "mcp-status"));
  } catch (error) {
    if (error.code === "ENOENT") return statuses;
    throw error;
  }
  for (const file of files)
    try {
      const entry = JSON.parse(await readFile(join(root, "mcp-status", file), "utf8"));
      await readFile(join(root, "browser-bridges", `${entry.pid}.json`), "utf8");
      process.kill(entry.pid, 0); // signal 0 只读存活性；不能把已退出进程的遗留状态算成 connected。
      statuses[`plugin:${entry.pluginId.split("@")[0]}:${entry.name}`] = entry.status;
      if (entry.name === "node_repl") statuses.node_repl = entry.status;
    } catch {
      /* 旧进程或未完整提交的状态不作为运行事实。 */
    }
  return statuses;
}
