import type { AppSettings } from "@zcode/shared";
import type { InputRouting, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

export function resolveAppFollowupMode(
  settings: AppSettings | null | undefined,
): SessionConfigState["followupMode"] | null {
  if (!settings) return null;
  return settings.zcodeInteractionBehavior === "guide" ? "guide" : "queue";
}

export function resolveOppositeFollowupDelivery(
  mode: SessionConfigState["followupMode"],
): "startNow" | "queue" {
  // queue 模式的修饰键发送曾被解释成 guide；“立即发送”实际是队列既有的抢占语义。
  return mode === "guide" ? "queue" : "startNow";
}

/**
 * 插话（立即生效）显性入口的可见性裁决（R7）：
 * 运行中常驻，空草稿禁用由 composer 决定，避免只有输入之后才看得到入口。
 * 空闲时普通发送已覆盖 startNow，不另展示追加按钮。
 * 与修饰键路径（shouldReverseFollowupDeliveryForPointer）互不影响：按钮固定
 * requestedDelivery=startNow，修饰键仍是单次反向 delivery。
 */
export function shouldShowInterjectControl({
  canStop,
  hasDraftToSubmit: _hasDraftToSubmit,
}: {
  canStop: boolean;
  hasDraftToSubmit: boolean;
}): boolean {
  // 空草稿也保留入口，避免用户看不到如何追加；是否可发送由 composer 的 canSend 决定。
  return canStop;
}

export function shouldEnableModifiedEnterSubmit({
  inputRoutingMode,
}: {
  inputRoutingMode: InputRouting["mode"];
}): boolean {
  return inputRoutingMode !== "reject";
}

export function shouldReverseFollowupDeliveryForPointer({
  enabled,
  metaKey = false,
  ctrlKey = false,
  isApplePlatform,
}: {
  enabled: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isApplePlatform?: boolean;
}): boolean {
  return (
    enabled &&
    (isApplePlatform === undefined
      ? metaKey || ctrlKey
      : isPrimaryFollowupModifierPressed({ isApplePlatform, metaKey, ctrlKey }))
  );
}

export function isPrimaryFollowupModifierPressed({
  isApplePlatform,
  metaKey = false,
  ctrlKey = false,
}: {
  isApplePlatform: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  return isApplePlatform ? metaKey : ctrlKey;
}

interface FollowupModifierTooltip {
  delivery: "startNow" | "queue";
  shortcut: string;
  titleId: "chat.followup.sendNow" | "chat.followup.addToQueue";
}

export function resolveFollowupModifierTooltip({
  enabled,
  canSend,
  modifierPressed,
  followupMode,
  isApplePlatform,
}: {
  enabled: boolean;
  canSend: boolean;
  modifierPressed: boolean;
  followupMode: SessionConfigState["followupMode"] | undefined;
  isApplePlatform: boolean;
}): FollowupModifierTooltip | null {
  if (!enabled || !canSend || !modifierPressed || !followupMode) return null;
  const delivery = resolveOppositeFollowupDelivery(followupMode);
  return {
    delivery,
    shortcut: isApplePlatform ? "⌘ + Enter" : "Ctrl + Enter",
    titleId: delivery === "startNow" ? "chat.followup.sendNow" : "chat.followup.addToQueue",
  };
}
