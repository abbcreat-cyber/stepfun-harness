import { join, resolve } from "node:path";
import type { StepBuiltinHook, StepBuiltinHookId } from "../stepBuiltinHooks.js";
import { STEP_BUILTIN_HOOK_IDS, readStepBuiltinHooks } from "../stepBuiltinHooksRuntime.mjs";
import { atomicWritePrivateTextFile, withFileLock } from "./privateFilePersistence.js";
export { readStepBuiltinHooks };
export async function setStepBuiltinHookEnabled(root: string, id: StepBuiltinHookId, enabled: boolean): Promise<StepBuiltinHook[]> {
  if (!STEP_BUILTIN_HOOK_IDS.includes(id) || typeof enabled !== "boolean") throw new Error("无效的内置钩子开关");
  const file = join(resolve(root), "desktop-hooks.json");
  return withFileLock(file, async () => {
    const hooks = await readStepBuiltinHooks(root);
    const next = hooks.map(hook => hook.id === id ? { ...hook, enabled } : hook);
    await atomicWritePrivateTextFile(file, JSON.stringify({ version: 1, enabled: Object.fromEntries(next.map(hook => [hook.id, hook.enabled])) }, null, 2));
    return next;
  });
}
