/** 用户可管理的内置行为，与命令钩子和插件内部事件分开建模。 */
export type StepBuiltinHookId = "first-principles" | "opening-explanation";
export interface StepBuiltinHook { id: StepBuiltinHookId; enabled: boolean; }
