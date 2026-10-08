import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
export const STEP_BUILTIN_HOOK_IDS = ["first-principles", "opening-explanation"];
export async function readStepBuiltinHooks(root) {
  let data;
  try { data = JSON.parse(await readFile(join(resolve(root), "desktop-hooks.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return STEP_BUILTIN_HOOK_IDS.map(id => ({ id, enabled: true }));
    throw new Error("内置钩子配置无法读取，请检查 desktop-hooks.json", { cause: error });
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1 ||
      Object.keys(data).some(key => !["version", "enabled"].includes(key)) || !data.enabled ||
      typeof data.enabled !== "object" || Array.isArray(data.enabled)) throw new Error("内置钩子配置格式错误");
  if (Object.keys(data.enabled).some(key => !STEP_BUILTIN_HOOK_IDS.includes(key) || typeof data.enabled[key] !== "boolean")) throw new Error("内置钩子开关格式错误");
  return STEP_BUILTIN_HOOK_IDS.map(id => ({ id, enabled: data.enabled[id] !== false }));
}
