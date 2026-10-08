import test from "node:test";
import assert from "node:assert/strict";
import { queueItemSchema, queueStateSchema } from "@zcode/shared/zcode-protocol-v4";
import type { QueueItem, QueueState, SessionActionAvailability } from "@zcode/shared/zcode-protocol-v4";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import {
  STEP_AVAILABILITY_DISABLED_REASON_FALLBACK_MESSAGE_ID,
  STEP_MODEL_DEFERRED_REASON_CODE,
  STEP_QUEUE_EXPERIENCE_MESSAGE_IDS,
  STEP_UPSTREAM_ABORTED_ERROR_MESSAGE_ID,
  formatStepAvailabilityDisabledReason,
  formatStepQueuePanelReadOnlyReason,
  getStepAvailabilityDisabledReasonMessageId,
  isStepQueueItemModelDeferred,
  isStepQueueItemSteerApproximation,
  isStepUpstreamAbortedErrorText,
  localizeStepUpstreamAbortedErrorText,
  resolveStepQueueEditGate,
  resolveStepQueueItemDispatchLabelKey,
  resolveStepQueuePauseBanner,
  resolveStepQueueRoutingHintKey,
  resolveStepQueueSendNowGate,
  sortStepQueueItemsByOrder,
  type StepQueueActionGate,
  type StepQueueFormatMessage,
} from "../src/v4/composer/stepQueueExperience.js";

/**
 * 队列体验组纯函数测试（Step 桥接队列体验组，对应
 * docs/step-input-admission-queue-spec.md §1.1/§6 与 docs/step-capability-matrix.md §1/§5）。
 *
 * 运行方式（ui 包无独立 test script，沿用仓库 stepcode-adapter 的 node --test 约定）：
 * `npx tsx --test packages/ui/test/stepComposerQueueExperience.test.ts`
 * （本文件只 import 纯函数模块与 locale 纯记录，不触 @/ 路径别名与 React，可在 node 直跑。）
 */

/** 队列项 fixture：先过协议 queueItemSchema（.strict()）再喂被测函数，顺带验证 fixture 形状。 */
function makeQueueItem(overrides: Record<string, unknown> = {}): QueueItem {
  const raw = {
    sourceCommandId: "cmd_1",
    queueItemId: "qi_cmd_1",
    clientId: "client-a",
    kind: "sendText",
    text: "排队消息",
    attachments: [],
    delivery: { requested: "auto", admitted: "queue" },
    order: { admissionSeq: 1, queuePosition: 1 },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: 1,
    ...overrides,
  };
  return queueItemSchema.parse(raw) as QueueItem;
}

function makeQueueState(overrides: Partial<QueueState> = {}): QueueState {
  const raw = {
    items: [makeQueueItem()],
    autoDrain: true,
    ...overrides,
  };
  return queueStateSchema.parse(raw) as QueueState;
}

const formatMessageStub: StepQueueFormatMessage = (descriptor, values) =>
  `id:${descriptor.id}${values ? `:${JSON.stringify(values)}` : ""}`;

function gate(allowed: boolean, reasonCode?: string): StepQueueActionGate {
  return { allowed, reasonCode: reasonCode ?? null };
}

const BRIDGE_AVAILABILITY: SessionActionAvailability = {
  fork: { allowed: false, reasonCode: "stepcode.community.forkNotWired" },
  compact: { allowed: false, reasonCode: "stepcode.community.compactNotWired" },
  switchModelConfig: { allowed: true },
  setFollowupMode: { allowed: true },
  queueEdit: { allowed: false, reasonCode: "stepcode.community.queueEditNotWired" },
  sendQueuedNow: { allowed: false, reasonCode: "stepcode.community.queueEditNotWired" },
  pauseGoal: { allowed: false, reasonCode: "stepcode.community.noGoal" },
  resumeGoal: { allowed: false, reasonCode: "stepcode.community.noGoal" },
};

test("queueEdit/sendQueuedNow 门控按 availability 如实裁决", () => {
  // Step 桥接现状（矩阵 §1）：queueEdit 与 sendQueuedNow 双双 allowed:false。
  const editGate = resolveStepQueueEditGate(BRIDGE_AVAILABILITY);
  assert.equal(editGate.allowed, false);
  assert.equal(editGate.reasonCode, "stepcode.community.queueEditNotWired");
  const sendNowGate = resolveStepQueueSendNowGate(BRIDGE_AVAILABILITY);
  assert.equal(sendNowGate.allowed, false);
  assert.equal(sendNowGate.reasonCode, "stepcode.community.queueEditNotWired");

  // 官方 CLI：allowed:true。
  const officialCliAvailability: SessionActionAvailability = {
    ...BRIDGE_AVAILABILITY,
    queueEdit: { allowed: true },
    sendQueuedNow: { allowed: true },
  };
  assert.deepEqual(resolveStepQueueEditGate(officialCliAvailability), { allowed: true, reasonCode: null });
  assert.deepEqual(
    resolveStepQueueSendNowGate(officialCliAvailability),
    { allowed: true, reasonCode: null },
  );

  // 旧快照/旧 CLI：availability 缺省（undefined/null）按可用处理，官方行为不变。
  assert.deepEqual(resolveStepQueueEditGate(undefined), { allowed: true, reasonCode: null });
  assert.deepEqual(resolveStepQueueEditGate(null), { allowed: true, reasonCode: null });
  assert.deepEqual(resolveStepQueueSendNowGate(undefined), { allowed: true, reasonCode: null });
});

test("禁用原因文案：已知 reasonCode 走专用 key，未知 reasonCode 落通用兜底", () => {
  // 已知（矩阵 §1 reasonCode 全集）。
  const knownCodes: Record<string, string> = {
    "stepcode.community.queueEditNotWired": "chat.availability.reason.stepcode.community.queueEditNotWired",
    "stepcode.community.forkNotWired": "chat.availability.reason.stepcode.community.forkNotWired",
    "stepcode.community.compactNotWired": "chat.availability.reason.stepcode.community.compactNotWired",
    "stepcode.community.noGoal": "chat.availability.reason.stepcode.community.noGoal",
    "stepcode.community.noAtomicPreempt": "chat.availability.reason.stepcode.community.noAtomicPreempt",
    "stepcode.community.guideNotWired": "chat.availability.reason.stepcode.community.guideNotWired",
  };
  for (const [reasonCode, expectedMessageId] of Object.entries(knownCodes)) {
    assert.equal(getStepAvailabilityDisabledReasonMessageId(reasonCode), expectedMessageId, reasonCode);
  }

  // 未知 reasonCode → 通用兜底。
  assert.equal(
    getStepAvailabilityDisabledReasonMessageId("stepcode.community.brandNewCode"),
    STEP_AVAILABILITY_DISABLED_REASON_FALLBACK_MESSAGE_ID,
  );
  assert.equal(
    getStepAvailabilityDisabledReasonMessageId(null),
    STEP_AVAILABILITY_DISABLED_REASON_FALLBACK_MESSAGE_ID,
  );
  assert.equal(
    getStepAvailabilityDisabledReasonMessageId(undefined),
    STEP_AVAILABILITY_DISABLED_REASON_FALLBACK_MESSAGE_ID,
  );

  // formatter：allowed → null；已知 → 专用 key；未知 → 通用 key 且 reasonCode 作插值传入。
  assert.equal(formatStepAvailabilityDisabledReason(gate(true), formatMessageStub), null);
  assert.equal(
    formatStepAvailabilityDisabledReason(
      gate(false, "stepcode.community.queueEditNotWired"),
      formatMessageStub,
    ),
    "id:chat.availability.reason.stepcode.community.queueEditNotWired",
  );
  assert.equal(
    formatStepAvailabilityDisabledReason(
      gate(false, "stepcode.community.brandNewCode"),
      formatMessageStub,
    ),
    'id:chat.availability.reason.generic:{"reasonCode":"stepcode.community.brandNewCode"}',
  );
});

test("停止后队列横幅：resumeSupported=false 走「保留展示、不再执行」语义", () => {
  // 空队列 / 未暂停 → null（与旧 ConversationQueuePanel 空态一致）。
  assert.equal(
    resolveStepQueuePauseBanner({ queue: makeQueueState({ items: [] }), resumeSupported: false }),
    null,
  );
  assert.equal(
    resolveStepQueuePauseBanner({ queue: makeQueueState({ autoDrain: true }), resumeSupported: false }),
    null,
  );

  // Step 桥接现状：stop 冻结（autoDrain=false + pauseReason="stopped"）且不可恢复。
  const retained = resolveStepQueuePauseBanner({
    queue: makeQueueState({ autoDrain: false, pauseReason: "stopped" }),
    resumeSupported: false,
  });
  assert.equal(retained?.tone, "stoppedRetained");
  assert.equal(retained?.messageKey, "chat.queue.stopped.retained");
  assert.equal(typeof retained?.hintKey, "string");

  // 官方 CLI：同状态但可恢复 → 既有「已暂停」文案，无新增 hint。
  const resumable = resolveStepQueuePauseBanner({
    queue: makeQueueState({ autoDrain: false, pauseReason: "stopped" }),
    resumeSupported: true,
  });
  assert.equal(resumable?.tone, "stoppedResumable");
  assert.equal(resumable?.messageKey, "chat.queue.paused.stopped");
  assert.equal(resumable?.hintKey, null);

  // error / manual / 缺省 → 既有文案。
  const errored = resolveStepQueuePauseBanner({
    queue: makeQueueState({ autoDrain: false, pauseReason: "error" }),
    resumeSupported: false,
  });
  assert.equal(errored?.tone, "error");
  assert.equal(errored?.messageKey, "chat.queue.paused.error");
  const generic = resolveStepQueuePauseBanner({
    queue: makeQueueState({ autoDrain: false, pauseReason: "manual" }),
    resumeSupported: true,
  });
  assert.equal(generic?.tone, "generic");
  assert.equal(generic?.messageKey, "chat.queue.paused.generic");
  const missingPauseReason = resolveStepQueuePauseBanner({
    queue: makeQueueState({ autoDrain: false }),
    resumeSupported: true,
  });
  assert.equal(missingPauseReason?.tone, "generic");
});

test("steer 降级近似标注：只认 delivery.fallbackReasonCode，裸 steering 不误标", () => {
  // 决议③：降级标注的唯一机器可辨信号是 delivery.fallbackReasonCode
  // （桥接规格保证降级项必带，input-admission.mjs queueItems 投影）。
  assert.equal(
    isStepQueueItemSteerApproximation(
      makeQueueItem({
        delivery: { requested: "startNow", admitted: "queue", fallbackReasonCode: "stepcode.community.noAtomicPreempt" },
      }),
    ),
    true,
  );
  // 桥接 steered 项的完整形态：steer.state=steering + delivery.fallbackReasonCode 双带。
  assert.equal(
    isStepQueueItemSteerApproximation(
      makeQueueItem({
        steer: { state: "steering", reasonCode: "stepcode.community.noAtomicPreempt" },
        delivery: { requested: "startNow", admitted: "queue", fallbackReasonCode: "stepcode.community.noAtomicPreempt" },
      }),
    ),
    true,
  );
  // 裸 steer.state="steering"（无 delivery.fallbackReasonCode）不是降级近似——官方 CLI
  // 有真抢占原语，steering 是合法真实态，不许套「无抢占原语」文案（R2 评审 low：
  // steer 误标 CLI 真 steer）。
  assert.equal(
    isStepQueueItemSteerApproximation(
      makeQueueItem({ steer: { state: "steering", reasonCode: "stepcode.community.noAtomicPreempt" } }),
    ),
    false,
  );
  assert.equal(isStepQueueItemSteerApproximation(makeQueueItem({ steer: { state: "steering" } })), false);
  // 普通排队项不是近似。
  assert.equal(isStepQueueItemSteerApproximation(makeQueueItem()), false);
  assert.equal(
    isStepQueueItemSteerApproximation(
      makeQueueItem({ steer: { state: "guided" }, delivery: { requested: "queue", admitted: "queue" } }),
    ),
    false,
  );
  // 其他 fallbackReasonCode 值不触发降级标注（只认 noAtomicPreempt 这一个语义）。
  assert.equal(
    isStepQueueItemSteerApproximation(
      makeQueueItem({
        delivery: { requested: "queue", admitted: "queue", fallbackReasonCode: "stepcode.community.someFutureCode" },
      }),
    ),
    false,
  );
});

test("队列项排序：queuePosition 优先，缺失时按 admissionSeq 兜底，同序值稳定", () => {
  const third = makeQueueItem({
    queueItemId: "qi_3",
    order: { admissionSeq: 3, queuePosition: 3 },
  });
  const first = makeQueueItem({
    queueItemId: "qi_1",
    order: { admissionSeq: 1, queuePosition: 1 },
  });
  const second = makeQueueItem({
    queueItemId: "qi_2",
    order: { admissionSeq: 2, queuePosition: 2 },
  });
  const sorted = sortStepQueueItemsByOrder([third, first, second]);
  assert.deepEqual(
    sorted.map((item) => item.queueItemId),
    ["qi_1", "qi_2", "qi_3"],
  );

  // 同 admissionSeq 保持输入顺序（稳定排序，不因并列而重排）。
  const tied = sortStepQueueItemsByOrder([third, first]);
  assert.deepEqual(
    tied.map((item) => item.queueItemId),
    ["qi_1", "qi_3"],
  );

  // 决议②：queuePosition 存在时优先按 queuePosition——即使与 admissionSeq 相悖
  // （桥接现状两键同值；若后端开始投影真实队列位次，排序必须跟随之，不得还原入场序）。
  const lateAdmissionEarlyPosition = makeQueueItem({
    queueItemId: "qi_late_promoted",
    order: { admissionSeq: 9, queuePosition: 1 },
  });
  const earlyAdmissionLatePosition = makeQueueItem({
    queueItemId: "qi_early_demoted",
    order: { admissionSeq: 1, queuePosition: 9 },
  });
  const byPosition = sortStepQueueItemsByOrder([earlyAdmissionLatePosition, lateAdmissionEarlyPosition]);
  assert.deepEqual(
    byPosition.map((item) => item.queueItemId),
    ["qi_late_promoted", "qi_early_demoted"],
  );

  // queuePosition 缺失（旧快照/旧 CLI）→ 按 admissionSeq 兜底；混排时逐项取
  // queuePosition ?? admissionSeq 作主键，admissionSeq 作次键，输入序作稳定尾键。
  // qi_no_pos 与 qi_2 主键并列（2），次键并列（2）→ 按输入序稳定：qi_no_pos 在前。
  const noPosition = makeQueueItem({ queueItemId: "qi_no_pos", order: { admissionSeq: 2 } });
  const mixed = sortStepQueueItemsByOrder([first, noPosition, second]);
  assert.deepEqual(
    mixed.map((item) => item.queueItemId),
    ["qi_1", "qi_no_pos", "qi_2"],
  );
});

test("模型降级标记识别（spec §9 modelDeferred）：followUp 占 delivery 槽 / steer 挂 steer.reasonCode，双槽任一命中", () => {
  // followUp 形状（桥接投影：delivery 槽空闲 → modelDeferred 占位）。
  assert.equal(
    isStepQueueItemModelDeferred(
      makeQueueItem({
        modelSelection: { providerId: "step", modelId: "deepseek-chat" },
        delivery: { requested: "queue", admitted: "queue", fallbackReasonCode: "stepcode.community.modelDeferred" },
      }),
    ),
    true,
  );
  // steer 形状（delivery 槽保持 noAtomicPreempt，模型降级挂 steer.reasonCode）。
  const steerDeferred = makeQueueItem({
    steer: { state: "steering", reasonCode: "stepcode.community.modelDeferred" },
    delivery: { requested: "startNow", admitted: "queue", fallbackReasonCode: "stepcode.community.noAtomicPreempt" },
  });
  assert.equal(isStepQueueItemModelDeferred(steerDeferred), true);
  // steer 项双徽标并存：投递降级（steerApprox）与模型降级（modelDeferred）同时命中，
  // 渲染层两个徽标并列展示（ComposerQueueDisplay 行内两段 JSX）。
  assert.equal(isStepQueueItemSteerApproximation(steerDeferred), true);

  // 反例：裸 noAtomicPreempt（投递降级但无模型降级）不是模型降级。
  assert.equal(
    isStepQueueItemModelDeferred(
      makeQueueItem({
        delivery: { requested: "queue", admitted: "queue", fallbackReasonCode: "stepcode.community.noAtomicPreempt" },
      }),
    ),
    false,
  );
  // 反例：普通排队项 / 裸 steering（官方 CLI 真 steer，无降级标记）/ 未知码 / 无模型选择。
  assert.equal(isStepQueueItemModelDeferred(makeQueueItem()), false);
  assert.equal(isStepQueueItemModelDeferred(makeQueueItem({ steer: { state: "steering" } })), false);
  assert.equal(
    isStepQueueItemModelDeferred(
      makeQueueItem({
        delivery: { requested: "queue", admitted: "queue", fallbackReasonCode: "stepcode.community.someFutureCode" },
      }),
    ),
    false,
  );
  // 常量与协议 reasonCode 字面量一致（spec §9 机读规则的锚点）。
  assert.equal(STEP_MODEL_DEFERRED_REASON_CODE, "stepcode.community.modelDeferred");
});

test("透传断言：桥接投影形状的 queueItem 标记经 shared schema parse 后仍能到达渲染层识别函数", () => {
  // 桥接台账投影（input-admission.mjs queueItems()）的逐字形状——busy+显式模型选择的
  // followUp 项：模型意图进 queueItem.modelSelection（请求值），降级标记占
  // delivery.fallbackReasonCode（该槽空闲；不与 noAtomicPreempt 抢位）。
  const bridgeFollowUpDeferred = {
    sourceCommandId: "cmd_2",
    queueItemId: "qi_cmd_2",
    clientId: "stepcode-bridge",
    kind: "sendText",
    text: "带显式模型的排队消息",
    attachments: [],
    modelSelection: { providerId: "step", modelId: "deepseek-chat" },
    delivery: { requested: "auto", admitted: "queue", fallbackReasonCode: "stepcode.community.modelDeferred" },
    order: { admissionSeq: 2, queuePosition: 2 },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: 1,
    provenance: { sourceCommandId: "cmd_2", queueItemId: "qi_cmd_2", clientId: "stepcode-bridge" },
  };
  // steer+显式模型：delivery 槽保持 noAtomicPreempt（steerApprox 识别依赖），模型降级挂
  // steer.reasonCode——同为 input-intent.ts 已声明字段，快照链路 zod parse 存活（ACK 的
  // additive 字段经宿主会被 strip，故 UI 只认 queueItem 投影这条通道，spec §9 ①②）。
  const bridgeSteerDeferred = {
    ...bridgeFollowUpDeferred,
    sourceCommandId: "cmd_3",
    queueItemId: "qi_cmd_3",
    text: "带显式模型的插话",
    delivery: { requested: "startNow", admitted: "queue", fallbackReasonCode: "stepcode.community.noAtomicPreempt" },
    steer: { state: "steering", reasonCode: "stepcode.community.modelDeferred" },
    order: { admissionSeq: 3, queuePosition: 3 },
    provenance: { sourceCommandId: "cmd_3", queueItemId: "qi_cmd_3", clientId: "stepcode-bridge" },
  };

  // 整帧 queueState 过宿主同款 parse。strict 收口在 queueItemSchema 链路子 schema
  // （intent 及 delivery/order/steer/dispatch/provenance 均 .strict()，item 级未知键
  // 会被拒）；queueStateSchema 顶层是普通 z.object，顶层未知键被剥不报错。标记字段
  // （delivery.fallbackReasonCode / steer.reasonCode）声明被删则本测试必炸——标记必须
  // 存活到 parse 输出、且渲染层识别函数（ComposerQueueDisplay 消费）能读到。
  const parsed = queueStateSchema.parse({
    items: [makeQueueItem(), bridgeFollowUpDeferred, bridgeSteerDeferred],
    autoDrain: true,
  });
  const [, followUpDeferred, steerDeferred] = parsed.items as QueueItem[];
  assert.deepEqual(
    parsed.items.map((item) => isStepQueueItemModelDeferred(item as QueueItem)),
    [false, true, true],
  );
  assert.equal(
    followUpDeferred.delivery.fallbackReasonCode,
    "stepcode.community.modelDeferred",
  );
  assert.equal(steerDeferred.steer.reasonCode, "stepcode.community.modelDeferred");
  assert.equal(isStepQueueItemModelDeferred(followUpDeferred), true);
  assert.equal(isStepQueueItemModelDeferred(steerDeferred), true);
  // 双徽标并存形态：steer 项两个标注都命中（渲染层徽标 testid 后缀 steer-approx / model-deferred）。
  assert.equal(isStepQueueItemSteerApproximation(steerDeferred), true);
  assert.equal(isStepQueueItemSteerApproximation(followUpDeferred), false);

  // 渲染层文案 key：徽标 label 与 tooltip 都已登记进防漂移清单（下面的 i18n 用例双语言校验）。
  assert.deepEqual(
    ["chat.queue.item.modelDeferred", "chat.queue.item.modelDeferred.tooltip"].filter(
      (id) => STEP_QUEUE_EXPERIENCE_MESSAGE_IDS.includes(id),
    ),
    ["chat.queue.item.modelDeferred", "chat.queue.item.modelDeferred.tooltip"],
  );
});

test("队列项投递态标注：仅 reserved/promoting 有标注，queued 是常态", () => {
  assert.equal(
    resolveStepQueueItemDispatchLabelKey(makeQueueItem({ dispatch: { state: "reserved" } })),
    "chat.queue.item.dispatch.reserved",
  );
  assert.equal(
    resolveStepQueueItemDispatchLabelKey(makeQueueItem({ dispatch: { state: "promoting" } })),
    "chat.queue.item.dispatch.promoting",
  );
  assert.equal(resolveStepQueueItemDispatchLabelKey(makeQueueItem()), null);
});

test("inputRouting 提示：enqueue/guide 给文案，startNow/choice/reject 不重复既有通道", () => {
  assert.equal(resolveStepQueueRoutingHintKey(null), null);
  assert.equal(resolveStepQueueRoutingHintKey(undefined), null);
  assert.equal(resolveStepQueueRoutingHintKey({ mode: "enqueue" }), "chat.queue.routing.enqueue");
  // Step 桥接的 guide 路由带 reasonCode=guideNotWired（input-admission.mjs inputRouting）。
  assert.equal(
    resolveStepQueueRoutingHintKey({ mode: "guide", reasonCode: "stepcode.community.guideNotWired" }),
    "chat.queue.routing.guide",
  );
  // 官方 CLI 的 guide 路由（无降级 reasonCode）不提示——那是既有的合法路由。
  assert.equal(resolveStepQueueRoutingHintKey({ mode: "guide" }), null);
  assert.equal(resolveStepQueueRoutingHintKey({ mode: "startNow" }), null);
  assert.equal(resolveStepQueueRoutingHintKey({ mode: "choice" }), null);
  assert.equal(resolveStepQueueRoutingHintKey({ mode: "reject", reasonCode: "x" }), null);
});

test("面板标题 tooltip：queueEdit 与 sendQueuedNow 两门禁用原因合并（同句去重、单门也显示）", () => {
  // 桥接现状（conversation-snapshot.mjs）：两门同码 queueEditNotWired → 去重后只显示一句，
  // 不复读同一句（旧实现只挂 editGate，本用例锁死合并行为）。
  assert.equal(
    formatStepQueuePanelReadOnlyReason(
      gate(false, "stepcode.community.queueEditNotWired"),
      gate(false, "stepcode.community.queueEditNotWired"),
      formatMessageStub,
    ),
    "id:chat.availability.reason.stepcode.community.queueEditNotWired",
  );

  // 两门不同码 → 两句按序（先 edit 后 sendNow）以换行拼接（title 原生 tooltip 支持多行）。
  assert.equal(
    formatStepQueuePanelReadOnlyReason(
      gate(false, "stepcode.community.queueEditNotWired"),
      gate(false, "stepcode.community.brandNewCode"),
      formatMessageStub,
    ),
    'id:chat.availability.reason.stepcode.community.queueEditNotWired\nid:chat.availability.reason.generic:{"reasonCode":"stepcode.community.brandNewCode"}',
  );

  // 单门禁用也显示（R3 评审 low 场景）：queueEdit 允许而 sendQueuedNow 禁用——旧实现只挂
  // editGate 原因会静默丢掉 sendNow 侧原因；反向（只 edit 禁用）保持旧语义不变。
  assert.equal(
    formatStepQueuePanelReadOnlyReason(
      gate(true),
      gate(false, "stepcode.community.sendNowNotWired"),
      formatMessageStub,
    ),
    'id:chat.availability.reason.generic:{"reasonCode":"stepcode.community.sendNowNotWired"}',
  );
  assert.equal(
    formatStepQueuePanelReadOnlyReason(
      gate(false, "stepcode.community.queueEditNotWired"),
      gate(true),
      formatMessageStub,
    ),
    "id:chat.availability.reason.stepcode.community.queueEditNotWired",
  );

  // 两门都允许（官方 CLI / 缺省）→ null，不挂 tooltip。
  assert.equal(formatStepQueuePanelReadOnlyReason(gate(true), gate(true), formatMessageStub), null);
});

test("「Request was aborted」/「The operation was aborted」识别：整句精确匹配（大小写/空白/句号宽容，子串不误伤）", () => {
  // 命中：Step 后端 abort 时投影的原生错误文本（P0 验收 S3 观察项 ①）。
  assert.equal(isStepUpstreamAbortedErrorText("Request was aborted"), true);
  assert.equal(isStepUpstreamAbortedErrorText("request was aborted"), true);
  assert.equal(isStepUpstreamAbortedErrorText(" Request was aborted. "), true);
  assert.equal(isStepUpstreamAbortedErrorText("Request Was Aborted"), true);
  assert.equal(isStepUpstreamAbortedErrorText("Request was aborted."), true);

  // 命中：round5 补复测真机发现的第二个英文变体「The operation was aborted.」。
  assert.equal(isStepUpstreamAbortedErrorText("The operation was aborted."), true);
  assert.equal(isStepUpstreamAbortedErrorText("The operation was aborted"), true);
  assert.equal(isStepUpstreamAbortedErrorText(" the operation was aborted "), true);
  assert.equal(isStepUpstreamAbortedErrorText("THE OPERATION WAS ABORTED."), true);

  // 不命中：正文里合法包含该字样、其他错误文本、空值。
  assert.equal(isStepUpstreamAbortedErrorText("Request was aborted by the user"), false);
  assert.equal(isStepUpstreamAbortedErrorText("The request was aborted"), false);
  assert.equal(isStepUpstreamAbortedErrorText("The operation was aborted by the user"), false);
  assert.equal(isStepUpstreamAbortedErrorText("The operation was aborted, please retry"), false);
  assert.equal(isStepUpstreamAbortedErrorText("Something went wrong"), false);
  assert.equal(isStepUpstreamAbortedErrorText(""), false);
  assert.equal(isStepUpstreamAbortedErrorText(null), false);
  assert.equal(isStepUpstreamAbortedErrorText(undefined), false);

  // 中止文本（两个变体）→ 本地化 key；其他失败行正文原样保留（不许掩盖真实错误）。
  assert.equal(
    localizeStepUpstreamAbortedErrorText("Request was aborted", formatMessageStub),
    `id:${STEP_UPSTREAM_ABORTED_ERROR_MESSAGE_ID}`,
  );
  assert.equal(
    localizeStepUpstreamAbortedErrorText("The operation was aborted.", formatMessageStub),
    `id:${STEP_UPSTREAM_ABORTED_ERROR_MESSAGE_ID}`,
  );
  assert.equal(
    localizeStepUpstreamAbortedErrorText("Something went wrong", formatMessageStub),
    "Something went wrong",
  );
  assert.equal(
    localizeStepUpstreamAbortedErrorText("The operation was aborted by the user", formatMessageStub),
    "The operation was aborted by the user",
  );
  assert.equal(localizeStepUpstreamAbortedErrorText(null, formatMessageStub), null);
  assert.equal(localizeStepUpstreamAbortedErrorText("", formatMessageStub), "");
});

test("i18n 防漂移：队列体验组引用的全部 key 在 zh-CN 与 en-US 双语齐备且非空", () => {
  const locales: Record<string, Record<string, string>> = {
    "zh-CN": zhCN as Record<string, string>,
    "en-US": enUS as Record<string, string>,
  };
  for (const [localeName, messages] of Object.entries(locales)) {
    for (const messageId of STEP_QUEUE_EXPERIENCE_MESSAGE_IDS) {
      const value = messages[messageId];
      assert.equal(
        typeof value === "string" && value.trim().length > 0,
        true,
        `${localeName} 缺失或空 key：${messageId}`,
      );
    }
  }
});
