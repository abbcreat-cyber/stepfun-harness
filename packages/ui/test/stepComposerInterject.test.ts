import test from "node:test";
import assert from "node:assert/strict";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import {
  resolveOppositeFollowupDelivery,
  shouldReverseFollowupDeliveryForPointer,
  shouldShowInterjectControl,
} from "../src/v4/composer/followupModeSettings.js";
import { STEP_QUEUE_EXPERIENCE_MESSAGE_IDS } from "../src/v4/composer/stepQueueExperience.js";

/**
 * 插话（立即生效）显性入口组测试（R7 插话轮）：
 * - shouldShowInterjectControl：忙碌+有草稿才出现（与「加入队列」发送键并列；Stop 态与
 *   空闲态不出现）。
 * - 修饰键路径保留（不因显性按钮而回归）：queue 模式反向 delivery=startNow。
 * - i18n 防漂移：chat.composer.interject / chat.composer.interject.tooltip 双语齐备
 *   （同时已登记进 STEP_QUEUE_EXPERIENCE_MESSAGE_IDS 主防漂移清单）。
 *
 * 运行方式（ui 包无独立 test script，沿用仓库 node --test + tsx 约定）：
 * `npx tsx --test packages/ui/test/stepComposerInterject.test.ts`
 * （只 import 纯函数模块与 locale 纯记录，不触 @/ 路径别名与 React，可在 node 直跑。）
 */

test("追加入口可见性：运行中常驻，空闲隐藏，空草稿可发现", () => {
  assert.equal(shouldShowInterjectControl({ canStop: true, hasDraftToSubmit: true }), true, "忙碌中输入插话内容 → 按钮出现");
  assert.equal(shouldShowInterjectControl({ canStop: true, hasDraftToSubmit: false }), true, "忙碌且无草稿仍展示入口，由发送能力禁用");
  assert.equal(shouldShowInterjectControl({ canStop: false, hasDraftToSubmit: true }), false, "空闲有草稿 → 不出现（普通发送已覆盖 startNow）");
  assert.equal(shouldShowInterjectControl({ canStop: false, hasDraftToSubmit: false }), false);
});

test("修饰键路径保留：queue 模式修饰发送仍反向为 startNow（插话按钮不取代它）", () => {
  assert.equal(resolveOppositeFollowupDelivery("queue"), "startNow");
  assert.equal(resolveOppositeFollowupDelivery("guide"), "queue");
  // Ctrl+点击反向（Windows/Linux）与 ⌘+点击反向（Apple）仍生效。
  assert.equal(
    shouldReverseFollowupDeliveryForPointer({ enabled: true, ctrlKey: true, isApplePlatform: false }),
    true,
  );
  assert.equal(
    shouldReverseFollowupDeliveryForPointer({ enabled: true, metaKey: true, isApplePlatform: true }),
    true,
  );
  // enabled=false（不可停止/空闲）时修饰点击不反向。
  assert.equal(
    shouldReverseFollowupDeliveryForPointer({ enabled: false, ctrlKey: true, isApplePlatform: false }),
    false,
  );
});

test("i18n 防漂移：插话入口两个 key 在 zh-CN 与 en-US 双语齐备且非空，并已登记主清单", () => {
  const locales: Record<string, Record<string, string>> = {
    "zh-CN": zhCN as Record<string, string>,
    "en-US": enUS as Record<string, string>,
  };
  for (const messageId of ["chat.composer.interject", "chat.composer.interject.tooltip"]) {
    assert.equal(
      STEP_QUEUE_EXPERIENCE_MESSAGE_IDS.includes(messageId),
      true,
      `${messageId} 必须登记进 STEP_QUEUE_EXPERIENCE_MESSAGE_IDS（主防漂移清单）`,
    );
    for (const [localeName, messages] of Object.entries(locales)) {
      const value = messages[messageId];
      assert.equal(
        typeof value === "string" && value.trim().length > 0,
        true,
        `${localeName} 缺失或空 key：${messageId}`,
      );
    }
  }
});
