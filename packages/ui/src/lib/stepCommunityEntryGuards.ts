import type { SessionActionAvailability } from "@zcode/shared/zcode-protocol-v4";
import type { StepQueueActionGate } from "@/v4/composer/stepQueueExperience.js";

/**
 * stepCommunityEntryGuards —— Step-Code 社区桥接「点了必败/半失败」入口的门控裁决与文案。
 *
 * 依据（docs/step-capability-matrix.md §5 入口清理组，2026-10-05 唯一事实源）：
 * - /compact：会话快照 availability.compact（allowed=false + reasonCode）是权威声明，
 *   桥接 v4/command 无处理分支（-32602）。门控按快照声明裁决，不依赖社区身份信号
 *   ——官方 CLI（allowed=true 或键缺席）路径完全不受影响。
 * - 任务重命名：桥接已接通 renameSession（P1-01：原生 set_session_name + 四落点一致 +
 *   custom 防覆盖），adapter renameTask 的 v4 同步真实生效，无需社区身份提示——
 *   原「范围提示」常量与 tooltip 接线已撤除（历史见 §5 已处理清单）。
 *
 * 会话级 reasonCode → 本地化文案复用 stepQueueExperience 的既有映射
 * （stepcode.community.compactNotWired 等文案 key 已在 locales 落地，未收录代码走
 * 带原因代码插值的通用兜底）。
 */

/**
 * compact 斜杠命令门（SessionPane 的 dispatchSlashCommand 边界消费；禁用原因文案用
 * stepQueueExperience 的 formatStepAvailabilityDisabledReason 渲染，覆盖矩阵 §1 的
 * reasonCode 全集，未收录代码走带原因代码插值的通用兜底）。
 *
 * 缺省语义与队列组门控（resolveStepQueueEditGate）一致：availability 缺席
 * （旧 CLI / 快照未到）按可用处理，保持官方 CLI 行为不变；只有快照显式声明
 * allowed=false（社区桥接 reasonCode=stepcode.community.compactNotWired）才拦截。
 */
export function resolveStepCompactGate(
  availability: SessionActionAvailability | null | undefined,
): StepQueueActionGate {
  const gate = availability?.compact;
  if (!gate) return { allowed: true, reasonCode: null };
  if (gate.allowed) return { allowed: true, reasonCode: null };
  return { allowed: false, reasonCode: gate.reasonCode };
}
