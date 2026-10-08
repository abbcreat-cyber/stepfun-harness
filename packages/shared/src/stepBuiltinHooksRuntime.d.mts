export const STEP_BUILTIN_HOOK_IDS: readonly ["first-principles", "opening-explanation"];
export function readStepBuiltinHooks(root: string): Promise<Array<{ id: (typeof STEP_BUILTIN_HOOK_IDS)[number]; enabled: boolean }>>;
