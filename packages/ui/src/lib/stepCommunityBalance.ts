import type { StepCommunityBalance } from "@zcode/services";

/**
 * stepCommunityBalance —— 侧栏左下角「阶跃星辰余额」只读行的状态裁决与金额格式化。
 *
 * 唯一事实源是 host 侧 IStepCommunityService.getAccountBalance() 的投影结果
 * （docs/step-account-balance-spec.md）：renderer 只投影，不派生、不换算、不缓存、不落盘。
 * 裁决语义（spec §renderer 侧契约）：
 * - 非社区态 / 未接入 key / 非 api 连接模式（subscription）=> hidden，整行不挂载；
 * - 已接入且请求在途（尚无投影）=> loading，展示读取中占位；
 * - status==="ok" 且主金额有限 => ready，如实展示（余额本身为 0 也显示 0.00）；
 * - status==="ok" 但主金额缺失 => empty，展示占位文案；
 * - 其余（no-key/unsupported/network/invalid）=> error，整行不渲染，不显示假数、不显示 0 兜底。
 */

/** 余额行的 UI 状态：hidden/error 态调用方不挂载节点。 */
export type StepBalanceUiStatus = "loading" | "hidden" | "login" | "ready" | "empty" | "error";

export interface StepBalanceSecondary {
  cash: number | null;
  voucher: number | null;
}

export interface StepBalanceView {
  status: StepBalanceUiStatus;
  primary: number | null;
  secondary: StepBalanceSecondary;
}

const NO_SECONDARY: StepBalanceSecondary = { cash: null, voucher: null };

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 把 host 投影结果裁决成 UI 可消费的余额视图。active/connected 为 false 时一律 hidden
 * （未接入 key 时整行不渲染，loading 态也不渲染）。
 */
export function resolveStepCommunityBalanceView(input: {
  active: boolean;
  connected: boolean;
  loading: boolean;
  balance: StepCommunityBalance | null;
}): StepBalanceView {
  if (!input.active) {
    return { status: "hidden", primary: null, secondary: NO_SECONDARY };
  }
  if (!input.connected || input.balance?.status === "no-key" || input.balance?.status === "invalid") {
    return { status: "login", primary: null, secondary: NO_SECONDARY };
  }

  const balance = input.balance;
  if (!balance) {
    return { status: input.loading ? "loading" : "empty", primary: null, secondary: NO_SECONDARY };
  }

  if (balance.status !== "ok") {
    return { status: "error", primary: null, secondary: NO_SECONDARY };
  }

  const primary = finiteOrNull(balance.balance);
  if (primary === null) {
    return { status: input.loading ? "loading" : "empty", primary: null, secondary: NO_SECONDARY };
  }

  return {
    status: "ready",
    primary,
    secondary: {
      cash: finiteOrNull(balance.totalCashBalance),
      voucher: finiteOrNull(balance.totalVoucherBalance),
    },
  };
}

/**
 * 金额投影格式（spec：固定两位小数 + 千分位，如 1,234.56）。
 * 非有限输入（NaN/Infinity/非 number）返回 ""，绝不让非法值变成界面数字。
 */
export function formatStepAmount(v: number): string {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return "";
  }
  const sign = v < 0 ? "-" : "";
  return `${sign}${Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}
