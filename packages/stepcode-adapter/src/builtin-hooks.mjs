import { readStepBuiltinHooks } from "@zcode/shared/step-builtin-hooks-runtime";
export async function readBuiltinHooks(root) {
  // 同一配置契约同时服务设置页和 SDK，不维护第二份开关表。
  if (!root) return { "first-principles": true, "opening-explanation": true };
  return Object.fromEntries((await readStepBuiltinHooks(root)).map(hook => [hook.id, hook.enabled]));
}
export const FIRST_PRINCIPLES_REMINDER = "\n<desktop_first_principles>\n从第一性原理出发解决当前任务：先明确真实目标、已知事实与必要约束，区分事实与假设，将问题拆解到基本要素，再推导并验证解决方案。按任务复杂度采用适当深度，简单任务直接解决，无需向用户复述这条提醒。\n</desktop_first_principles>";
