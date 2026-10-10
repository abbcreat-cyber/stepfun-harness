import { Anchor } from "lucide-react";
import type { StepBuiltinHook, StepBuiltinHookId } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function builtinHookCopy(id: StepBuiltinHookId, locale: string) {
  const zh = locale.startsWith("zh");
  return id === "first-principles"
    ? {
        title: zh ? "第一性原理提醒" : "First-principles reminder",
        description: zh
          ? "任务开始时，先明确目标、事实与约束，再推导并验证方案。"
          : "Start by identifying goals, facts and constraints, then derive and verify a solution.",
        event: "UserPromptSubmit",
      }
    : {
        title: zh ? "开场说明" : "Opening explanation",
        description: zh
          ? "尽早说明目标和第一步，再深入执行。支持的模型会增加一次有长度和时限的简短开场请求，主任务思考设置保持不变。"
          : "Explain the goal and first step early. Supported models use one brief, bounded opening request; the main task keeps its thinking settings.",
        event: "BeforeAgentStart · PreToolUse",
      };
}

export function BuiltinHookRow({
  hook,
  busy,
  onToggle,
}: {
  hook: StepBuiltinHook;
  busy: boolean;
  onToggle?: (hook: StepBuiltinHook, enabled: boolean) => Promise<void>;
}) {
  const { locale } = useZCodeIntl();
  const copy = builtinHookCopy(hook.id, locale),
    zh = locale.startsWith("zh");
  return (
    <div className="flex items-center gap-3 px-4 py-3" data-testid={`builtin-hook-${hook.id}`}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground-subtle">
        <Anchor className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-base font-medium text-foreground">{copy.title}</span>
          <span className="rounded bg-background px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            {zh ? "内置" : "Built in"}
          </span>
        </div>
        <p className="mt-1 text-ui-sm text-foreground-subtle">{copy.description}</p>
        <p className="mt-1 text-ui-xs text-foreground-subtle">
          {copy.event} · {zh ? "从下一轮发送生效" : "Applies to the next turn"}
        </p>
      </div>
      <Switch
        checked={hook.enabled}
        disabled={busy || !onToggle}
        aria-label={copy.title}
        onCheckedChange={(enabled) => {
          void onToggle?.(hook, enabled);
        }}
      />
    </div>
  );
}
