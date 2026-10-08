import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

export const STEP_PLUGIN_MANIFEST = "step.plugin.json";
export const STEP_PLUGIN_DISABLED_MANIFEST = "step.plugin.disabled.json";

/** 声明文件本身是唯一开关事实；关闭仍保留原根目录及完整配置。 */
export async function readStepPluginDeclaration(directory) {
  for (const [fileName, enabled] of [
    [STEP_PLUGIN_MANIFEST, true],
    [STEP_PLUGIN_DISABLED_MANIFEST, false],
  ]) {
    try {
      return {
        fileName,
        enabled,
        manifest: JSON.parse(await readFile(join(directory, fileName), "utf8")),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

let persistence;
async function sharedPersistence() {
  persistence ??= (async () => {
    const { register } = await import("tsx/esm/api");
    register();
    return import("@zcode/shared/node");
  })();
  return persistence;
}

/** 与 SkillsService 使用同一稳定存储根锁；目录移动不能把锁本体一起搬走。 */
export async function withStepPluginState(root, operation) {
  const { withFileLock } = await sharedPersistence();
  return withFileLock(join(resolve(root), ".step-plugin-state"), operation);
}

export async function writeStepPluginState(file, content) {
  const { atomicWritePrivateTextFile } = await sharedPersistence();
  return atomicWritePrivateTextFile(file, content);
}
