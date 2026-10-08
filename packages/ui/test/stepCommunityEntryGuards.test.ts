import test from "node:test";
import assert from "node:assert/strict";
import { sessionActionAvailabilitySchema } from "@zcode/shared/zcode-protocol-v4";
import type { SessionActionAvailability } from "@zcode/shared/zcode-protocol-v4";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import { getStepAvailabilityDisabledReasonMessageId } from "../src/v4/composer/stepQueueExperience.js";
import {
  resolveStepCompactGate,
} from "../src/lib/stepCommunityEntryGuards.js";

/**
 * 社区桥接「点了必败/半失败」入口清理组测试（对应
 * docs/step-capability-matrix.md §5 入口清理组：/compact 斜杠命令门控、
 * 设置页交互行为 guide 置灰的文案引用闭环）。
 * 任务重命名范围提示已随 P1-01 撤除（桥接 renameSession 已接通，提示不再成立），
 * 对应断言一并移除。
 *
 * 运行方式（ui 包无独立 test script，沿用仓库 stepcode-adapter 的 node --test 约定）：
 * `npx tsx --test packages/ui/test/stepCommunityEntryGuards.test.ts`
 * （本文件只 import 纯函数模块与 locale 纯记录；stepCommunityEntryGuards.ts 对
 * stepQueueExperience 仅 type-only import，编译后擦除，不触 @/ 路径别名与 React。）
 */

/** 协议形状的 availability fixture：先过 sessionActionAvailabilitySchema（.strict()）再喂被测函数。 */
function makeAvailability(overrides: Record<string, unknown> = {}): SessionActionAvailability {
  return sessionActionAvailabilitySchema.parse({
    fork: { allowed: false, reasonCode: "stepcode.community.forkNotWired" },
    compact: { allowed: true },
    switchModelConfig: { allowed: true },
    setFollowupMode: { allowed: true },
    queueEdit: { allowed: false, reasonCode: "stepcode.community.queueEditNotWired" },
    sendQueuedNow: { allowed: false, reasonCode: "stepcode.community.queueEditNotWired" },
    pauseGoal: { allowed: false, reasonCode: "stepcode.community.noGoal" },
    resumeGoal: { allowed: false, reasonCode: "stepcode.community.noGoal" },
    ...overrides,
  });
}

test("compact 门：快照声明 allowed=false 才拦截，reasonCode 原样透传", () => {
  // 社区桥接快照（docs/step-capability-matrix.md §1）：compact 真实禁用值。
  const bridge = makeAvailability({
    compact: { allowed: false, reasonCode: "stepcode.community.compactNotWired" },
  });
  assert.deepEqual(resolveStepCompactGate(bridge), {
    allowed: false,
    reasonCode: "stepcode.community.compactNotWired",
  });

  // 官方 CLI / 后端支持压缩：allowed=true 放行（拦截 toast 与命令都不会发生）。
  const official = makeAvailability({ compact: { allowed: true } });
  assert.deepEqual(resolveStepCompactGate(official), { allowed: true, reasonCode: null });

  // 其他键的取值不影响 compact 门裁决（fork 门控由消费方自行读取）。
  const bridgeWithForkAllowed = makeAvailability({
    compact: { allowed: false, reasonCode: "stepcode.community.compactNotWired" },
    fork: { allowed: true },
  });
  assert.deepEqual(resolveStepCompactGate(bridgeWithForkAllowed), {
    allowed: false,
    reasonCode: "stepcode.community.compactNotWired",
  });
});

test("compact 门：availability 缺省（undefined/null）按可用处理，官方 CLI 行为不变", () => {
  assert.deepEqual(resolveStepCompactGate(undefined), { allowed: true, reasonCode: null });
  assert.deepEqual(resolveStepCompactGate(null), { allowed: true, reasonCode: null });
});

test("guide 置灰引用闭环：stepcode.community.guideNotWired 命中专用文案 key 且双语齐备", () => {
  // settingsPageHelpers 的 zcodeInteractionBehavior guide 项硬编码引用该 reasonCode
  // （社区身份下置灰说明）。锁定它必须命中专用文案而非通用兜底——若同事后续重构
  // stepQueueExperience 的 reasonCode 映射表，这里会先红，避免设置页说明悄悄退化成
  // 「该功能在当前后端暂不可用（原因代码：stepcode.community.guideNotWired）」。
  const messageId = getStepAvailabilityDisabledReasonMessageId("stepcode.community.guideNotWired");
  assert.equal(
    messageId,
    "chat.availability.reason.stepcode.community.guideNotWired",
  );
  // SessionPane 的 compact 拦截文案同理（reasonCode 来自快照动态值，此处锁定文案 key 本身存在）。
  const compactMessageId = getStepAvailabilityDisabledReasonMessageId(
    "stepcode.community.compactNotWired",
  );
  assert.equal(
    compactMessageId,
    "chat.availability.reason.stepcode.community.compactNotWired",
  );

  const locales: Record<string, Record<string, string>> = {
    "zh-CN": zhCN as Record<string, string>,
    "en-US": enUS as Record<string, string>,
  };
  for (const [localeName, messages] of Object.entries(locales)) {
    for (const key of [messageId, compactMessageId]) {
      const value = messages[key];
      assert.equal(
        typeof value === "string" && value.trim().length > 0,
        true,
        `${localeName} 缺失或空 key：${key}`,
      );
    }
  }
});
