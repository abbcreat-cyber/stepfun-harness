import type {
  InputRouting,
  QueueItem,
  QueueState,
  SessionActionAvailability,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * v4 队列体验的纯投影层（Step 桥接 + 官方 CLI 共用）。
 *
 * 背景（docs/step-input-admission-queue-spec.md §6 + docs/step-capability-matrix.md §1/§5）：
 * - Step 桥接自 P0-02 起如实把 queue.items / inputRouting / autoDrain / pauseReason 投影进快照，
 *   但 queueEdit / sendQueuedNow / setAutoDrain 是「明确未支持」（allowed:false + reasonCode，
 *   或 v4 命令 switch 无分支 → -32602）。UI 侧再渲染这些入口就是可见死按钮。
 * - stop 后台账冻结：队列项保留展示（autoDrain=false + pauseReason="stopped"），但底座池已被
 *   abort 清空，恢复执行的原语未接——语义是「保留展示、不再执行」，不是「已暂停可恢复」。
 *
 * 本模块只做纯裁决：availability → 动作门控、reasonCode → 本地化文案 key、queue 状态 →
 * 停止语义横幅、排队项排序/steer 降级标注、inputRouting → composer 提示、上游中止错误文本
 * （"Request was aborted" / "The operation was aborted"）的本地化识别。渲染件见 ComposerQueueDisplay.tsx；接线点见
 * SessionPane.tsx 的 ConversationQueuePanel 渲染处与 ConversationRowView.tsx 的
 * AssistantTextRowView。
 */

/** locale 占位符插值签名（与 useZCodeIntl 的 IntlInstance.formatMessage 同形，便于纯函数测试）。 */
export type StepQueueFormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** 单个能力入口的展示裁决：allowed=false 时必带协议 reasonCode。 */
export interface StepQueueActionGate {
  allowed: boolean;
  reasonCode: string | null;
}

/**
 * queueEdit 门（覆盖 editQueueItem / reorderQueueItem / deleteQueueItem 三条命令——
 * 协议 availability 只有一个 queueEdit 键，矩阵 §1 也按同一键声明）。
 * availability 缺省（旧 CLI / 旧快照）时按可用处理，保持官方 CLI 行为不变。
 */
export function resolveStepQueueEditGate(
  availability: SessionActionAvailability | null | undefined,
): StepQueueActionGate {
  const gate = availability?.queueEdit;
  if (!gate) return { allowed: true, reasonCode: null };
  if (gate.allowed) return { allowed: true, reasonCode: null };
  return { allowed: false, reasonCode: gate.reasonCode };
}

/** sendQueuedNow 门（「立即/提升发送」按钮）。缺省按可用处理（同上）。 */
export function resolveStepQueueSendNowGate(
  availability: SessionActionAvailability | null | undefined,
): StepQueueActionGate {
  const gate = availability?.sendQueuedNow;
  if (!gate) return { allowed: true, reasonCode: null };
  if (gate.allowed) return { allowed: true, reasonCode: null };
  return { allowed: false, reasonCode: gate.reasonCode };
}

// ── reasonCode → 本地化文案 key（禁用原因展示，矩阵 §1 的 reasonCode 全集）──

/**
 * 已知 reasonCode → 专用文案 key。未收录的 reasonCode 落
 * getStepAvailabilityDisabledReasonFallbackMessageId() 的通用兜底（带 reasonCode 插值，
 * 方便用户报障时给出可检索的代码）。reasonCode 是协议稳定值，新增桥接 reasonCode 时
 * 必须同步补 key（packages/ui/src/i18n/locales/{zh-CN,en-US}.ts）与本表。
 */
const STEP_AVAILABILITY_DISABLED_REASON_MESSAGE_IDS: Readonly<
  Record<string, string>
> = {
  "stepcode.community.queueEditNotWired": "chat.availability.reason.stepcode.community.queueEditNotWired",
  "stepcode.community.forkNotWired": "chat.availability.reason.stepcode.community.forkNotWired",
  "stepcode.community.compactNotWired": "chat.availability.reason.stepcode.community.compactNotWired",
  "stepcode.community.noGoal": "chat.availability.reason.stepcode.community.noGoal",
  "stepcode.community.noAtomicPreempt": "chat.availability.reason.stepcode.community.noAtomicPreempt",
  "stepcode.community.guideNotWired": "chat.availability.reason.stepcode.community.guideNotWired",
};

/** 未收录 reasonCode 的通用兜底文案 key（{reasonCode} 占位符）。 */
export const STEP_AVAILABILITY_DISABLED_REASON_FALLBACK_MESSAGE_ID =
  "chat.availability.reason.generic";

export function getStepAvailabilityDisabledReasonMessageId(
  reasonCode: string | null | undefined,
): string {
  if (reasonCode && STEP_AVAILABILITY_DISABLED_REASON_MESSAGE_IDS[reasonCode]) {
    return STEP_AVAILABILITY_DISABLED_REASON_MESSAGE_IDS[reasonCode];
  }
  return STEP_AVAILABILITY_DISABLED_REASON_FALLBACK_MESSAGE_ID;
}

/**
 * 把一个门控裁决格式化成面向用户的禁用原因文案。
 * allowed=true → null（入口照常渲染，不需要原因提示）。
 */
export function formatStepAvailabilityDisabledReason(
  gate: StepQueueActionGate,
  formatMessage: StepQueueFormatMessage,
): string | null {
  if (gate.allowed || !gate.reasonCode) return null;
  const messageId = getStepAvailabilityDisabledReasonMessageId(gate.reasonCode);
  if (messageId === STEP_AVAILABILITY_DISABLED_REASON_FALLBACK_MESSAGE_ID) {
    return formatMessage({ id: messageId }, { reasonCode: gate.reasonCode });
  }
  return formatMessage({ id: messageId });
}

/**
 * 面板标题 tooltip 的只读原因文案：合并 queueEdit 与 sendQueuedNow 两门的禁用原因
 * （R3 评审 low——旧实现只挂 editGate 原因，「queueEdit 允许而 sendQueuedNow 禁用」的
 * 组合会静默隐藏按钮且无任何提示）。allowed=true 的门产出 null 被过滤；格式化后的
 * 句子逐句去重（桥接现状两门同码 stepcode.community.queueEditNotWired → 只显示一句，
 * 避免同一句复读）；非空句以换行拼接（title 属性原生 tooltip 支持多行）；全空 → null
 * （入口照常渲染，不需要原因提示）。
 */
export function formatStepQueuePanelReadOnlyReason(
  editGate: StepQueueActionGate,
  sendNowGate: StepQueueActionGate,
  formatMessage: StepQueueFormatMessage,
): string | null {
  const reasons = [
    formatStepAvailabilityDisabledReason(editGate, formatMessage),
    formatStepAvailabilityDisabledReason(sendNowGate, formatMessage),
  ].filter((reason): reason is string => reason !== null);
  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length === 0) return null;
  return uniqueReasons.join("\n");
}

// ── 停止后队列语义（「保留展示、不再执行」）──

/** 暂停/冻结横幅的语义分支（驱动文案 key 与「继续」按钮的显隐）。 */
export type StepQueuePauseBannerTone =
  | "stoppedRetained"
  | "stoppedResumable"
  | "error"
  | "generic";

export interface StepQueuePauseBanner {
  tone: StepQueuePauseBannerTone;
  /** 渲染用的 i18n key（见 zh-CN/en-US 的 chat.queue.*）。 */
  messageKey: string;
  /** 副文案（解释队列内容去向/如何继续）。 */
  hintKey: string | null;
}

/**
 * stop 后的队列横幅裁决：
 * - pauseReason="stopped" 且 resumeSupported=false → stoppedRetained（Step 桥接现状：
 *   setAutoDrain 未接，队列只保留展示、不再执行——文案必须直说，不能留「已暂停」的
 *   可恢复暗示）。
 * - pauseReason="stopped" 且 resumeSupported=true → stoppedResumable（官方 CLI：保留
 *   既有文案 + 「继续」按钮）。
 * - pauseReason="error" → error（既有文案）；其余 → generic 兜底。
 * 空队列或未暂停（autoDrain=true）→ null（与旧 ConversationQueuePanel 的空态一致）。
 *
 * resumeSupported：协议 availability 八键没有 setAutoDrain（矩阵 §1/§2——恢复队列执行
 * 属 setAutoDrain 管辖，明确未支持）。UI 只能显式声明：官方 CLI 传 true，Step 桥接传
 * false。协议补键后可改为读 availability。
 */
export function resolveStepQueuePauseBanner({
  queue,
  resumeSupported,
}: {
  queue: QueueState;
  resumeSupported: boolean;
}): StepQueuePauseBanner | null {
  if (queue.items.length === 0 || queue.autoDrain !== false) return null;
  if (queue.pauseReason === "stopped") {
    return resumeSupported
      ? { tone: "stoppedResumable", messageKey: "chat.queue.paused.stopped", hintKey: null }
      : {
          tone: "stoppedRetained",
          messageKey: "chat.queue.stopped.retained",
          hintKey: "chat.queue.stopped.retained.hint",
        };
  }
  if (queue.pauseReason === "error") {
    return { tone: "error", messageKey: "chat.queue.paused.error", hintKey: null };
  }
  return { tone: "generic", messageKey: "chat.queue.paused.generic", hintKey: null };
}

// ── 排队项排序 / steer 降级标注 / dispatch 态 ──

/**
 * busy+startNow 在 Step 桥接里走 steer 近似（spec §1.1），降级语义只认
 * delivery.fallbackReasonCode="stepcode.community.noAtomicPreempt"——桥接规格保证降级项
 * 必带该标记（input-admission.mjs queueItems 投影 delivery.fallbackReasonCode）。
 * 裸 steer.state="steering" 不算降级近似：官方 CLI 有真抢占原语，steering 是合法真实态，
 * 给它套「无抢占原语」文案会误标（R2 评审 low「steer 误标 CLI 真 steer」）。
 */
export function isStepQueueItemSteerApproximation(item: QueueItem): boolean {
  return item.delivery.fallbackReasonCode === "stepcode.community.noAtomicPreempt";
}

/**
 * Step 桥接忙碌排队的模型降级标记 reasonCode（spec §9）：带显式模型选择的消息在
 * 忙碌时入队（followUp/steer），模型意图只随 queueItem.modelSelection 记录、不切
 * 进程模型——轮到执行时用的是当时的会话模型，可能不按所选模型。含义=「执行时
 * 可能不按该模型」。
 */
export const STEP_MODEL_DEFERRED_REASON_CODE = "stepcode.community.modelDeferred";

/**
 * queueItem 的模型降级标记识别（spec §9 机读规则，两槽任一命中即降级）：
 * - followUp 项：delivery.fallbackReasonCode="stepcode.community.modelDeferred"
 *   （该槽空闲时占位）。
 * - steer 项：delivery 槽保持 noAtomicPreempt（isStepQueueItemSteerApproximation
 *   只认该码，不许覆盖），模型降级挂 steer.reasonCode（同为 input-intent.ts 已声明
 *   字段，快照链路 zod parse 存活）。
 * 只读 queueItem 投影——spec §9 ① 明示这是宿主/UI 的唯一可靠通道；ACK 的
 * inputAccepted.fallbackReasonCode 是 additive 字段，R5 起已在 shared command.ts
 * 声明、经宿主 commandAckSchema.parse 存活（旧表述「会被 strip」已过时），但 UI
 * 消费决议不变：仍以 queueItem 投影为准（spec §9 ②「UI 勿直接消费」，R3 评审 high），
 * 不读它。
 * 官方 CLI 无该 reasonCode，不受影响；steer 项可同时命中两个标注（投递降级 +
 * 模型降级），两个徽标并列展示。
 */
export function isStepQueueItemModelDeferred(item: QueueItem): boolean {
  return (
    item.delivery.fallbackReasonCode === STEP_MODEL_DEFERRED_REASON_CODE ||
    item.steer.reasonCode === STEP_MODEL_DEFERRED_REASON_CODE
  );
}

/**
 * 台账 order 的防御性稳定排序（仅桥接路径消费——官方 CLI 走旧 ConversationQueuePanel
 * 原样渲染，避免 admissionSeq 排序把 CLI 用户拖拽后的顺序还原回入场序，R2 评审 #⑤）：
 * - order.queuePosition 存在时优先按 queuePosition 升序（桥接现状投影
 *   queuePosition=admissionSeq，两键同值；若后端开始投影真实队列位次，这里直接跟随之）。
 * - queuePosition 缺失（旧快照/旧 CLI）时按 order.admissionSeq 升序兜底。
 * 同序值保持输入顺序稳定（不重排）。任何后端/投影路径打乱数组顺序都不会改变用户
 * 看到的执行顺序。
 */
export function sortStepQueueItemsByOrder(items: readonly QueueItem[]): QueueItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (a.item.order.queuePosition ?? a.item.order.admissionSeq) -
          (b.item.order.queuePosition ?? b.item.order.admissionSeq) ||
        a.item.order.admissionSeq - b.item.order.admissionSeq ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
}

/** queueItem.dispatch.state 的非默认态标注（reserved/promoting；queued 是常态不标）。 */
export function resolveStepQueueItemDispatchLabelKey(
  item: QueueItem,
): "chat.queue.item.dispatch.reserved" | "chat.queue.item.dispatch.promoting" | null {
  if (item.dispatch.state === "reserved") return "chat.queue.item.dispatch.reserved";
  if (item.dispatch.state === "promoting") return "chat.queue.item.dispatch.promoting";
  return null;
}

// ── inputRouting → composer 队列提示 ──

/**
 * busy 输入路由的提示文案裁决：
 * - enqueue：提示「当前回复结束后按顺序自动发送」——这是 P0-02 后队列真实续跑语义，
 *   让用户知道排队 ≠ 静默吞掉。
 * - guide：提示引导模式暂不可用（桥接 reasonCode=stepcode.community.guideNotWired；
 *   官方 CLI 的 guide 路由照旧，不提示）。
 * - startNow/choice/reject：null——startNow 无队列；choice 的二次确认与 reject 的禁发
 *   都已有既有 UI 通道（sendConfirm 弹窗与发送键禁用），这里不重复。
 */
export function resolveStepQueueRoutingHintKey(
  inputRouting: InputRouting | null | undefined,
): string | null {
  if (!inputRouting) return null;
  if (inputRouting.mode === "enqueue") return "chat.queue.routing.enqueue";
  if (inputRouting.mode === "guide" && inputRouting.reasonCode === "stepcode.community.guideNotWired") {
    return "chat.queue.routing.guide";
  }
  return null;
}

// ── 上游中止错误文本（"Request was aborted" / "The operation was aborted"）本地化识别 ──

/**
 * Step 后端在 turn 被 abort 时会把原生错误消息作为 errorMessage 行如实入账
 * （stream-projection.mjs 投影 assistantText state=failed），已知两个英文原文变体：
 * "Request was aborted"（P0 真实验收 S3 观察项 ①）与 "The operation was aborted."
 * （round5 补复测真机观察到的第二个变体）——英文原文直接展示给中文用户不友好。
 * 只做整句精确匹配（大小写不敏感、容忍首尾空白与句号），不做子串匹配——
 * assistantText 行正文可能合法包含这段字样（如 "The operation was aborted by the
 * user, so nothing was committed"），子串误伤会把正常回答改写掉。
 */
const STEP_UPSTREAM_ABORTED_ERROR_TEXT_PATTERN = /^(?:request|the operation) was aborted\.?$/i;

export function isStepUpstreamAbortedErrorText(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return STEP_UPSTREAM_ABORTED_ERROR_TEXT_PATTERN.test(text.trim());
}

/** 中止错误文案的本地化 key（zh=「已停止生成」，en=“Generation stopped”）。 */
export const STEP_UPSTREAM_ABORTED_ERROR_MESSAGE_ID = "chat.stop.aborted.upstreamMessage";

/**
 * 把上游 assistantText 失败行正文里的中止错误文本替换为本地化文案；非中止错误原样
 * 返回（桥接不许掩盖真实错误，只翻译这一句已知的固定原文）。
 * 消费点（决议）：ConversationRowView.tsx AssistantTextRowView 的 visibleText 计算，
 * 仅 row.state === "failed" 时套用。队列行（ComposerQueueDisplay）正文直接渲染
 * item.text 原文、不消费本函数——排队项 text 是用户输入，用户恰好输入这句话时会被
 * 误改写（R2 评审「队列项 abort 文案误伤面」）。适配层 stream-projection.mjs 是更深的
 * 落点，但那属于 adapter 领域，本轮不动。
 */
export function localizeStepUpstreamAbortedErrorText(
  text: string | null | undefined,
  formatMessage: StepQueueFormatMessage,
): string | null {
  if (!text) return text ?? null;
  if (!isStepUpstreamAbortedErrorText(text)) return text;
  return formatMessage({ id: STEP_UPSTREAM_ABORTED_ERROR_MESSAGE_ID });
}

/** 组件层引用的全部 i18n key 清单（测试用它做 zh/en 双语存在性防漂移）。 */
export const STEP_QUEUE_EXPERIENCE_MESSAGE_IDS = [
  "chat.queue.title",
  "chat.queue.sendNow",
  "chat.queue.runNow",
  "chat.queue.edit",
  "chat.queue.remove",
  "chat.queue.resume",
  "chat.queue.resume.description",
  "chat.queue.turnSteer.steering",
  // 插话显性入口（R7，followupModeSettings.shouldShowInterjectControl 消费方
  // ConversationComposer 的按钮 label 与 tooltip）。
  "chat.composer.interject",
  "chat.composer.interject.tooltip",
  "chat.queue.stopped.retained",
  "chat.queue.stopped.retained.hint",
  "chat.queue.paused.stopped",
  "chat.queue.paused.error",
  "chat.queue.paused.generic",
  "chat.queue.routing.enqueue",
  "chat.queue.routing.guide",
  "chat.queue.item.attachments",
  "chat.queue.item.dispatch.reserved",
  "chat.queue.item.dispatch.promoting",
  "chat.queue.steerApprox.tooltip",
  "chat.queue.item.modelDeferred",
  "chat.queue.item.modelDeferred.tooltip",
  "chat.availability.reason.generic",
  "chat.stop.aborted.upstreamMessage",
  ...Object.values(STEP_AVAILABILITY_DISABLED_REASON_MESSAGE_IDS),
] as const;
