import test from "node:test";
import assert from "node:assert/strict";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import type { StepCommunityBalance } from "@zcode/services";
import {
  formatStepAmount,
  resolveStepCommunityBalanceView,
} from "../src/lib/stepCommunityBalance.js";

/**
 * 侧栏左下角「阶跃星辰余额」只读行的纯函数测试（对应
 * docs/step-account-balance-spec.md §renderer 侧契约与验收场景）。
 *
 * 运行方式（ui 包无独立 test script，沿用仓库 node --test 约定）：
 * `npx tsx --test packages/ui/test/stepCommunityBalance.test.ts`
 * （本文件只 import 纯函数模块与 locale 纯记录；stepCommunityBalance.ts 对
 * @zcode/services 仅 type-only import，编译后擦除，不触运行时依赖与 React。）
 */

/** host 投影 fixture：先过 spec 字段面（status + 可选金额）再喂被测函数。 */
function makeBalance(overrides: Partial<StepCommunityBalance> = {}): StepCommunityBalance {
  return { status: "ok", balance: 1234.56, ...overrides } as StepCommunityBalance;
}

test("五态裁决：hidden/loading/ready/empty/error 各归其位", () => {
  assert.deepEqual(
    resolveStepCommunityBalanceView({
      active: false,
      connected: true,
      loading: true,
      balance: null,
    }).status,
    "hidden",
  );
  assert.deepEqual(
    resolveStepCommunityBalanceView({
      active: true,
      connected: false,
      loading: true,
      balance: null,
    }).status,
    "login",
  );
  assert.deepEqual(
    resolveStepCommunityBalanceView({
      active: true,
      connected: true,
      loading: true,
      balance: null,
    }).status,
    "loading",
  );
  const ready = resolveStepCommunityBalanceView({
    active: true,
    connected: true,
    loading: false,
    balance: makeBalance({ totalCashBalance: 1000, totalVoucherBalance: 234.56 }),
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.primary, 1234.56);
  assert.deepEqual(ready.secondary, { cash: 1000, voucher: 234.56 });
  assert.equal(
    resolveStepCommunityBalanceView({
      active: true,
      connected: true,
      loading: false,
      balance: makeBalance({ balance: undefined }),
    }).status,
    "empty",
  );
  // 未接入 key / 非 api 连接模式 / 网络失败 / key 失效 / 响应体非法一律不渲染。
  for (const status of ["no-key", "unsupported", "network", "invalid"] as const) {
    assert.equal(
      resolveStepCommunityBalanceView({
        active: true,
        connected: true,
        loading: false,
        balance: makeBalance({ status }),
      }).status,
      status === "no-key" || status === "invalid" ? "login" : "error",
      status,
    );
  }
});

test("secondary 缺省：现金/券字段缺席或非有限值时回落 null，不进界面", () => {
  const view = resolveStepCommunityBalanceView({
    active: true,
    connected: true,
    loading: false,
    balance: makeBalance({ totalCashBalance: undefined, totalVoucherBalance: undefined }),
  });
  assert.deepEqual(view.secondary, { cash: null, voucher: null });
  const nonFinite = resolveStepCommunityBalanceView({
    active: true,
    connected: true,
    loading: false,
    balance: makeBalance({ totalCashBalance: Number.NaN, totalVoucherBalance: Number.POSITIVE_INFINITY }),
  });
  assert.deepEqual(nonFinite.secondary, { cash: null, voucher: null });
});

test("余额本身为 0：如实展示 0.00，不隐藏、不判错", () => {
  const view = resolveStepCommunityBalanceView({
    active: true,
    connected: true,
    loading: false,
    balance: makeBalance({ balance: 0 }),
  });
  assert.equal(view.status, "ready");
  assert.equal(view.primary, 0);
  assert.equal(formatStepAmount(view.primary), "0.00");
});

test("API 已配置但请求未落定时保留余额行，不隐藏", () => {
  const view = resolveStepCommunityBalanceView({
    active: true,
    connected: true,
    loading: false,
    balance: null,
  });
  assert.equal(view.status, "empty");
  assert.equal(view.primary, null);
});

test("formatStepAmount：固定两位小数 + 千分位，非有限输入返回空串", () => {
  assert.equal(formatStepAmount(0), "0.00");
  assert.equal(formatStepAmount(1234.5), "1,234.50");
  assert.equal(formatStepAmount(1234567.89), "1,234,567.89");
  assert.equal(formatStepAmount(Number.NaN), "");
  assert.equal(formatStepAmount(Number.POSITIVE_INFINITY), "");
  assert.equal(formatStepAmount(Number.NEGATIVE_INFINITY), "");
});

test("中英 locale：余额行新增 key 齐全且非空", () => {
  const keys = [
    "sidebar.profile.stepCommunity.balance.label",
    "sidebar.profile.stepCommunity.balance.loading",
    "sidebar.profile.stepCommunity.balance.empty",
    "sidebar.profile.stepCommunity.balance.amount",
    "sidebar.profile.stepCommunity.balance.secondary",
  ];
  for (const record of [zhCN, enUS]) {
    for (const key of keys) {
      const value = (record as Record<string, string>)[key];
      assert.equal(typeof value, "string", key);
      assert.ok(value.length > 0, key);
    }
  }
  assert.equal(
    zhCN["sidebar.profile.stepCommunity.balance.amount"].includes("{amount}"),
    true,
  );
  assert.equal(
    enUS["sidebar.profile.stepCommunity.balance.amount"].includes("{amount}"),
    true,
  );
});
