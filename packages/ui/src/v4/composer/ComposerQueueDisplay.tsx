import { memo, useCallback, useState } from "react";
import {
  TID_V4_QUEUE,
  TID_V4_QUEUE_ITEM,
  TID_V4_QUEUE_ITEM_DELETE,
  TID_V4_QUEUE_ITEM_EDIT,
  TID_V4_QUEUE_ITEM_SEND_NOW,
  TID_V4_QUEUE_PAUSED_BANNER,
  TID_V4_QUEUE_RESUME,
  testId,
} from "@zcode/shared";
import type {
  InputRouting,
  QueueItem,
  QueueState,
  SessionActionAvailability,
} from "@zcode/shared/zcode-protocol-v4";
import { ArrowUpFromLine, Compass, HourglassIcon, PaperclipIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import {
  formatStepQueuePanelReadOnlyReason,
  isStepQueueItemModelDeferred,
  isStepQueueItemSteerApproximation,
  resolveStepQueueEditGate,
  resolveStepQueueItemDispatchLabelKey,
  resolveStepQueuePauseBanner,
  resolveStepQueueRoutingHintKey,
  resolveStepQueueSendNowGate,
  sortStepQueueItemsByOrder,
} from "@/v4/composer/stepQueueExperience.js";

interface ComposerQueueDisplayProps {
  /** v4 投影权威队列（snapshot.queue；含 guide 项时由调用方先 projectPendingGuideQueue）。 */
  queue: QueueState;
  /** v4 投影权威能力表（snapshot.availability）。缺省按官方 CLI 全可用处理。 */
  availability?: SessionActionAvailability | null;
  /** busy 输入路由（snapshot.inputRouting）——渲染排队提示文案用。 */
  inputRouting?: InputRouting | null;
  /**
   * 「继续」（恢复暂停队列的 setAutoDrain）是否被当前后端支持。
   * 协议 availability 八键没有 setAutoDrain（docs/step-capability-matrix.md §1/§2：
   * Step 桥接明确未支持），UI 只能显式声明：官方 CLI=true，Step 桥接=false。
   * false 时 stop 横幅走「保留展示、不再执行」语义，且不渲染死按钮。
   */
  resumeSupported?: boolean;
  /** 删除队列项（deleteQueueItem command）。仅 availability.queueEdit.allowed 且传入时渲染。 */
  onDeleteItem?: (queueItemId: string) => void;
  /** 撤回队列项到发起端 composer（editQueueItem 语义）。仅 queueEdit.allowed 且传入时渲染。 */
  onEditItem?: (queueItemId: string) => Promise<void> | void;
  /** 正在等待删除 ACK / composer restore 的目标项；仅锁该 row。 */
  pendingEditQueueItemId?: string | null;
  /** 立即发送队列项（sendQueuedNow command）。仅 availability.sendQueuedNow.allowed 且传入时渲染。 */
  onSendNow?: (queueItemId: string) => void;
  /** 恢复暂停队列（setAutoDrain true）。仅 resumeSupported 且传入时渲染。 */
  onResume?: () => Promise<void> | void;
  className?: string;
}

/**
 * 作曲器队列展示（v4 Step 桥接队列体验组）。
 *
 * 与旧 ConversationQueuePanel 的差别只在「诚实性」这一层：
 * - 动作按钮（立即发送/编辑/删除）逐项按 snapshot.availability 门控——allowed:false 时
 *   直接隐藏并在面板标题上保留禁用原因 tooltip（矩阵 §5.7：队列投影真实化后，
 *   桥接会话的旧面板会把必败按钮渲染出来）；官方 CLI 的 availability 全键 allowed=true
 *   或缺省，按钮照常渲染，行为不变。
 * - 不做拖拽排序：reorderQueueItem 也归 queueEdit 管。官方 CLI 路径继续用旧面板的
 *   dnd-kit；桥接路径 queueEdit=false，本面板保持只读。
 * - stop 后的横幅按 resumeSupported 分流：false →「保留展示、不再执行」（Step 桥接
 *   现状：池已被 abort 清空，恢复原语未接）；true → 既有「队列已暂停」+「继续」
 *   （「继续」与旧面板同款：runUserActionAsync 遥测 + pending disabled 防双击）。
 * - steer 降级标注只认 delivery.fallbackReasonCode（桥接规格保证降级项必带）；裸
 *   steer.state="steering" 是合法真实态（官方 CLI 有真抢占），不套「无抢占原语」文案。
 * - 模型降级标注（spec §9 modelDeferred）：忙碌时带显式模型选择入队的项徽标提示
 *   「执行时可能不按所选模型」——双槽识别（followUp 占 delivery 槽 / steer 挂
 *   steer.reasonCode），只读 queueItem 投影、不读 ACK（additive 字段经宿主会被 strip）。
 * - 队列行正文直接渲染 item.text 原文，不做 abort 文案本地化——排队项 text 是用户
 *   输入，整句恰好同名的输入会被误改写；时间线失败行（ConversationRowView）才是
 *   localizeStepUpstreamAbortedErrorText 的消费点。
 *
 * 接线点（SessionPane 所有者）：替换 SessionPane.tsx 现有
 * `<ConversationQueuePanel …/>`（4527-4540 附近）为本组件，传入
 * queue/availability/inputRouting/resumeSupported 与既有 handlers；旧面板与本组件共用
 * 同一组 TID 锚点（TID_V4_QUEUE / TID_V4_QUEUE_ITEM / *_DELETE / *_EDIT / *_SEND_NOW /
 * PAUSED_BANNER），E2E 契约不变，但两者不可同时渲染（testid 会重复）。
 */
function ComposerQueueDisplayImpl({
  queue,
  availability,
  inputRouting,
  resumeSupported = true,
  onDeleteItem,
  onEditItem,
  pendingEditQueueItemId = null,
  onSendNow,
  onResume,
  className,
}: ComposerQueueDisplayProps) {
  const { intl } = useZCodeIntl();
  const [resumePending, setResumePending] = useState(false);
  const editGate = resolveStepQueueEditGate(availability);
  const sendNowGate = resolveStepQueueSendNowGate(availability);
  const pauseBanner = resolveStepQueuePauseBanner({ queue, resumeSupported });
  const routingHintKey = resolveStepQueueRoutingHintKey(inputRouting);
  // 只读原因合并 queueEdit 与 sendQueuedNow 两门（R3 评审 low：只挂 editGate 会在
  // 「queueEdit 允许而 sendQueuedNow 禁用」的组合下静默隐藏按钮）。
  const panelReadOnlyReason = formatStepQueuePanelReadOnlyReason(editGate, sendNowGate, intl.formatMessage);
  const showSendNow = sendNowGate.allowed && Boolean(onSendNow);
  const showEdit = editGate.allowed && Boolean(onEditItem);
  const showDelete = editGate.allowed && Boolean(onDeleteItem);

  const handleSendNow = useCallback(
    (queueItemId: string) => {
      if (!onSendNow) return;
      runUserAction({
        input: {
          featureId: "conversation.queue.item",
          action: "send_now",
          trigger: "button",
        },
        operation: () => onSendNow(queueItemId),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "queue_send_now",
      });
    },
    [onSendNow],
  );

  // 「继续」与旧 ConversationQueuePanel 同款：runUserActionAsync 遥测
  // （featureId=conversation.queue.policy / failureStage=queue_resume）+ pending
  // disabled 防双击（决议⑤）。桥接现状 resumeSupported=false 不渲染本按钮，逻辑保留
  // 给支持 setAutoDrain 的后端路径。
  const handleResume = useCallback(async () => {
    if (!onResume || resumePending) return;
    setResumePending(true);
    try {
      await runUserActionAsync({
        input: { featureId: "conversation.queue.policy", action: "resume", trigger: "button" },
        operation: () => Promise.resolve(onResume()),
        completed: { resultSource: "authority_ack" },
        failureStage: "queue_resume",
      });
    } finally {
      setResumePending(false);
    }
  }, [onResume, resumePending]);

  if (queue.items.length === 0) return null;
  const items = sortStepQueueItemsByOrder(queue.items);
  return (
    <div
      data-testid={TID_V4_QUEUE}
      data-queue-count={queue.items.length}
      data-queue-auto-drain={queue.autoDrain ? "true" : "false"}
      data-queue-pause-reason={queue.pauseReason ?? ""}
      data-resume-supported={resumeSupported ? "true" : "false"}
      data-queue-edit-allowed={editGate.allowed ? "true" : "false"}
      data-queue-send-now-allowed={sendNowGate.allowed ? "true" : "false"}
      className={cn(
        "relative z-0 w-full overflow-hidden rounded-t-2xl border border-border bg-surface p-1 backdrop-blur-md",
        // 与旧 ConversationQueuePanel 同位：磨砂底衬在 composer 上沿，-mb-7+pb-7 抵消内边距避免双倍间距。
        "-mb-7 pb-7",
        className,
      )}
    >
      {/* 面板标题行：数量 + 顺序语义。queueEdit/sendQueuedNow 被后端禁用时把两门的
          禁用原因（合并去重）挂在本行 title 上——隐藏动作按钮（任务要求「展示禁用
          原因或直接隐藏」取隐藏），但保留一个可发现的 hover 提示说明为什么这里是只读的。 */}
      <p
        data-testid="composer-queue-count"
        title={panelReadOnlyReason ?? undefined}
        className="flex min-h-6 items-center gap-1.5 px-3 pt-1 text-ui-sm text-foreground-subtle"
      >
        {intl.formatMessage({ id: "chat.queue.title" }, { count: queue.items.length })}
      </p>
      {pauseBanner ? (
        <div
          data-testid={TID_V4_QUEUE_PAUSED_BANNER}
          data-queue-pause-tone={pauseBanner.tone}
          role="status"
          className="mb-1 flex min-h-10 items-start gap-3 rounded-xl border border-border/70 bg-surface-raised px-3 py-2 text-ui-base text-foreground"
        >
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: pauseBanner.messageKey })}
            {pauseBanner.hintKey ? (
              <span className="ml-1 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: pauseBanner.hintKey })}
              </span>
            ) : null}
          </span>
          {resumeSupported && onResume ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={TID_V4_QUEUE_RESUME}
              aria-label={intl.formatMessage({ id: "chat.queue.resume.description" })}
              disabled={resumePending}
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              onClick={() => void handleResume()}
            >
              {intl.formatMessage({ id: "chat.queue.resume" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {routingHintKey ? (
        <p
          data-testid="composer-queue-routing-hint"
          data-routing-mode={inputRouting?.mode ?? ""}
          data-routing-reason-code={inputRouting?.reasonCode ?? ""}
          className="mb-1 px-3 py-1 text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage({ id: routingHintKey })}
        </p>
      ) : null}
      <ul className="space-y-0.5">
        {items.map((item, index) => (
          <ComposerQueueRow
            key={item.queueItemId}
            item={item}
            index={index}
            editPending={pendingEditQueueItemId === item.queueItemId}
            showSendNow={showSendNow && item.steer.state !== "steering"}
            showEdit={showEdit && item.steer.state !== "steering"}
            showDelete={showDelete && item.steer.state !== "steering"}
            onSendNow={onSendNow ? handleSendNow : undefined}
            onEditItem={onEditItem}
            onDeleteItem={onDeleteItem}
          />
        ))}
      </ul>
    </div>
  );
}

interface ComposerQueueRowProps {
  item: QueueItem;
  index: number;
  editPending: boolean;
  showSendNow: boolean;
  showEdit: boolean;
  showDelete: boolean;
  onSendNow?: (queueItemId: string) => void;
  onEditItem?: (queueItemId: string) => Promise<void> | void;
  onDeleteItem?: (queueItemId: string) => void;
}

function ComposerQueueRow({
  item,
  index,
  editPending,
  showSendNow,
  showEdit,
  showDelete,
  onSendNow,
  onEditItem,
  onDeleteItem,
}: ComposerQueueRowProps) {
  const { intl } = useZCodeIntl();
  const steerApproximation = isStepQueueItemSteerApproximation(item);
  // 模型降级标记（spec §9）：忙碌时带显式模型选择入队的项——执行时可能不按所选模型。
  // 双槽任一命中（followUp 占 delivery 槽 / steer 挂 steer.reasonCode），详见纯函数层注释。
  const modelDeferred = isStepQueueItemModelDeferred(item);
  const dispatchLabelKey = resolveStepQueueItemDispatchLabelKey(item);
  const rowLocked = editPending || item.dispatch.state !== "queued";
  const isCompact = item.kind === "compact";
  return (
    <li
      data-testid={testId(TID_V4_QUEUE_ITEM, item.queueItemId)}
      data-queue-item-id={item.queueItemId}
      data-index={index}
      data-kind={item.kind}
      data-dispatch-state={item.dispatch.state}
      data-edit-pending={editPending ? "true" : "false"}
      data-steer-approximation={steerApproximation ? "true" : "false"}
      data-model-deferred={modelDeferred ? "true" : "false"}
      className={cn(
        "relative flex items-center gap-2 rounded-xl px-1.5 py-1 pr-1 transition-colors hover:bg-hover/30",
        editPending ? "opacity-60" : null,
      )}
    >
      <span
        aria-hidden="true"
        className="w-5 shrink-0 text-right text-ui-sm tabular-nums text-foreground-subtlest"
      >
        {index + 1}
      </span>
      <span
        className="flex min-w-0 flex-1 items-center gap-2 truncate text-ui-base text-foreground"
        title={item.text}
      >
        {/* 队列行正文渲染 item.text 原文（决议④）：排队项 text 是用户输入，不做 abort
            文案本地化，避免整句恰好同名的用户输入被误改写。compact 是斜杠命令字面量，
            与旧 ConversationQueuePanel 一致用等宽字体。 */}
        <span className={cn("truncate", isCompact ? "font-mono" : null)}>
          {isCompact ? "/compact" : item.text}
        </span>
        {!isCompact && item.attachments.length > 0 ? (
          <ControlHintTooltip
            title={intl.formatMessage(
              { id: "chat.queue.item.attachments" },
              { count: item.attachments.length },
            )}
          >
            <span
              data-testid={testId(testId(TID_V4_QUEUE_ITEM, item.queueItemId), "attachments")}
              className="inline-flex shrink-0 items-center gap-0.5 text-ui-sm text-foreground-subtle"
            >
              <PaperclipIcon className="size-3.5" aria-hidden="true" />
              {item.attachments.length}
            </span>
          </ControlHintTooltip>
        ) : null}
        {steerApproximation ? (
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.queue.steerApprox.tooltip" })}
          >
            <span
              data-testid={testId(testId(TID_V4_QUEUE_ITEM, item.queueItemId), "steer-approx")}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-raised px-1.5 py-0.5 text-ui-sm text-foreground-subtle"
            >
              <Compass className="size-3" aria-hidden="true" />
              {intl.formatMessage({ id: "chat.queue.turnSteer.steering" })}
            </span>
          </ControlHintTooltip>
        ) : null}
        {modelDeferred ? (
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.queue.item.modelDeferred.tooltip" })}
          >
            <span
              data-testid={testId(testId(TID_V4_QUEUE_ITEM, item.queueItemId), "model-deferred")}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-raised px-1.5 py-0.5 text-ui-sm text-foreground-subtle"
            >
              <HourglassIcon className="size-3" aria-hidden="true" />
              {intl.formatMessage({ id: "chat.queue.item.modelDeferred" })}
            </span>
          </ControlHintTooltip>
        ) : null}
        {dispatchLabelKey ? (
          <span className="shrink-0 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: dispatchLabelKey })}
          </span>
        ) : null}
      </span>
      {showSendNow ? (
        <Button
          type="button"
          variant="secondary"
          size="default"
          data-icon="inline-start"
          data-testid={testId(TID_V4_QUEUE_ITEM_SEND_NOW, item.queueItemId)}
          data-queue-item-id={item.queueItemId}
          disabled={rowLocked}
          onClick={() => onSendNow?.(item.queueItemId)}
        >
          <ArrowUpFromLine className="size-3.5" />
          {intl.formatMessage({ id: isCompact ? "chat.queue.runNow" : "chat.queue.sendNow" })}
        </Button>
      ) : null}
      {showEdit && !isCompact ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_EDIT, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.edit" })}
            disabled={rowLocked}
            onClick={() => void onEditItem?.(item.queueItemId)}
          >
            <PencilIcon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {showDelete ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.remove" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_DELETE, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.remove" })}
            disabled={rowLocked}
            onClick={() => onDeleteItem?.(item.queueItemId)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
    </li>
  );
}

export const ComposerQueueDisplay = memo(ComposerQueueDisplayImpl);
