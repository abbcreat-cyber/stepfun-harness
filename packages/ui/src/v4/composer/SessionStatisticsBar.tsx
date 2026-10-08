import { Gauge, Database } from "lucide-react";
import type { SessionUsageState } from "@zcode/shared/zcode-protocol-v4";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { ChatContextUsage } from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const tokens = (n: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
function duration(ms: number | null, zh: boolean) {
  if (ms === null) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}${zh ? "秒" : "s"}`;
  return `${Math.floor(seconds / 60)}${zh ? "分" : "m "}${Math.round(seconds % 60)}${zh ? "秒" : "s"}`;
}

const triggerClass =
  "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-2 py-1 text-ui-base text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground data-[state=open]:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring tabular-nums";
const panelClass = "w-80 max-w-[calc(100vw-2rem)] gap-0 rounded-xl p-4 shadow-md";
const headerClass =
  "mb-3 flex items-center justify-between gap-4 border-b border-border pb-3 text-ui-base text-foreground";

function StatisticsRows({ rows }: { rows: string[][] }) {
  return (
    <dl className="space-y-2 text-ui-base tabular-nums">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4">
          <dt className="text-foreground-subtle">{label}</dt>
          <dd className="shrink-0 text-foreground-subtle">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 纯展示：三个独立入口按参考图排序，数字仍只读当前 conversation 的 usage。 */
export function SessionStatisticsBar({ usage }: { usage: SessionUsageState | null }) {
  const { locale, intl } = useZCodeIntl();
  const zh = locale.startsWith("zh"),
    s = usage?.statistics;
  if (!s || !usage || (s.turns === 0 && s.steps === 0)) return null;
  const u = usage.cumulative;
  const input = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const total = input + u.outputTokens;
  const hit = input > 0 ? Math.min(100, (u.cacheReadTokens / input) * 100) : null;
  const hitText = hit === null ? "—" : `${hit.toFixed(hit < 1 && hit > 0 ? 1 : 0)}%`;
  const speed = s.tokensPerSecond === null ? "—" : `${Math.round(s.tokensPerSecond)} tok/s`;
  const fullTokens = (value: number) => `${new Intl.NumberFormat(locale).format(value)} tok`;
  const rows = [
    [zh ? "模型用时" : "Model time", duration(s.modelMs, zh)],
    [zh ? "工具调用用时" : "Tool time", duration(s.toolMs, zh)],
    [zh ? "首 token 平均（TTFT）" : "Average first token (TTFT)", duration(s.averageTtftMs, zh)],
    [zh ? "输出速度（TPS）" : "Output speed (TPS)", speed],
  ];
  const billing = [
    [zh ? "缓存命中" : "Cache hit", hitText],
    [zh ? "未缓存输入" : "Uncached input", fullTokens(u.inputTokens)],
    [zh ? "缓存读取" : "Cache read", fullTokens(u.cacheReadTokens)],
    [zh ? "输出" : "Output", fullTokens(u.outputTokens)],
  ];
  const context = usage.contextWindow;
  const taskUsage = context
    ? {
        used: context.usedTokens,
        size: context.maxTokens,
        ...(context.cache ? { cache: context.cache } : {}),
        ...(context.breakdown ? { breakdown: context.breakdown } : {}),
      }
    : null;

  return (
    <div
      data-testid="session-statistics-bar"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-1"
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="session-statistics-trigger"
            aria-label={zh ? "查看本会话统计" : "View session statistics"}
            className={triggerClass}
          >
            <Gauge className="size-3.5" aria-hidden="true" />
            <span>
              {s.turns} {zh ? "轮" : "turns"} {s.steps} {zh ? "步" : "steps"}
            </span>
            {s.tokensPerSecond !== null && (
              <>
                <span>·</span>
                <span>{speed}</span>
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={4}
          className={panelClass}
          data-testid="session-statistics-details"
        >
          <div className={headerClass}>
            <span className="flex items-center gap-2">
              <Gauge className="size-4" aria-hidden="true" />
              {zh ? "会话统计" : "Session statistics"}
            </span>
          </div>
          <StatisticsRows rows={rows} />
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="session-token-usage-trigger"
            aria-label={zh ? "查看 Token 用量" : "View token usage"}
            className={triggerClass}
          >
            <Database className="size-3.5" aria-hidden="true" />
            <span>
              {tokens(total)} tok · {zh ? "缓存命中" : "Cache hit"} {hitText}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={4}
          className={panelClass}
          data-testid="session-token-usage-details"
        >
          <div className={headerClass}>
            <span className="flex items-center gap-2 font-medium">
              <Database className="size-4" aria-hidden="true" />
              {zh ? "Token 用量" : "Token usage"}
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{fullTokens(total)}</span>
          </div>
          <StatisticsRows rows={billing} />
        </PopoverContent>
      </Popover>
      <ChatContextUsage taskUsage={taskUsage} intl={intl} locale={locale} showPercentage />
    </div>
  );
}
