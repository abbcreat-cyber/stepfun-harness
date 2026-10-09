import { mkdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { readStepPluginDeclaration, withStepPluginState, writeStepPluginState } from "../plugin-state.mjs";

const entry = fileURLToPath(new URL("../../bin/workflow-mcp.mjs", import.meta.url));
const normalized = value => {
  if (typeof value !== "string") return "";
  const path = normalize(value.replaceAll("\\", "/"));
  return process.platform === "win32" ? path.toLowerCase() : path;
};
function managed(manifest, root) {
  if (manifest.id !== "step_workflows") return false;
  if (manifest.stepManagedWorkflow === true) return true;
  const args = manifest.mcpServers?.step_workflows?.args;
  // 只认领旧安装器生成的精确形状；同名用户自建插件不接管。
  return manifest.name === "工作流" && manifest.version === "1.0.0" && Array.isArray(args) && args.length === 3 &&
    /(?:stepcode-adapter|harness-runtime[\\/]adapter)[\\/]bin[\\/]workflow-mcp\.mjs$/i.test(args[0]) &&
    args[1] === "--bridge-dir" && normalized(args[2]) === normalized(join(root, "browser-bridges"));
}

/** 安装与升级同一入口：只更新受管 MCP 的可执行路径，保留开关、env、timeout 和其他配置。 */
export async function installWorkflowPlugin(root) {
  if (!root) return;
  return withStepPluginState(root, async () => {
    let directory = join(root, "plugins", "step_workflows"), declaration;
    for (const parent of ["plugins", "disabled-plugins"]) {
      const candidate = join(root, parent, "step_workflows");
      const found = await readStepPluginDeclaration(candidate);
      if (found) { directory = candidate; declaration = found; break; }
    }
    if (declaration && !managed(declaration.manifest, root)) return;
    const manifest = declaration?.manifest ?? { id: "step_workflows", name: "工作流", version: "1.0.0",
      description: "复用动态工作流引擎，由 StepCode 执行子任务。" };
    const before = JSON.stringify(manifest);
    manifest.stepManagedWorkflow = true;
    manifest.mcpServers = { ...manifest.mcpServers, step_workflows: { ...manifest.mcpServers?.step_workflows,
      command: process.execPath, args: [entry, "--bridge-dir", join(root, "browser-bridges")] } };
    if (declaration && JSON.stringify(manifest) === before) return;
    await mkdir(directory, { recursive: true });
    await writeStepPluginState(join(directory, declaration?.fileName ?? "step.plugin.json"), JSON.stringify(manifest, null, 2));
  });
}
