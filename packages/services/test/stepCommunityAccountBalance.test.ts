/*
 * Step-Code 阶跃星辰账户余额（host 服务层）单测。
 *
 * 覆盖 docs/step-account-balance-spec.md 的 host 侧契约：成功解析、无 key 不发请求、
 * subscription 不发请求、401/403 → invalid、其它非 2xx → network、fetch 抛错 → network、
 * 非法 body → network、负值/非有限金额字段被舍弃。
 *
 * 安全纪律：用的全是由非敏感标记片段拼出的占位 key（绝不可能是真实凭据），
 * fetch 一律注入本地桩，绝不发往 api.stepfun.com。
 *
 * 运行方式（services 包惯例，无独立 test script）：
 *   cd packages/services && npx tsx --test test/stepCommunityAccountBalance.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelSelectionView } from "@zcode/provider";
import type { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import type { StepCommunityBalance } from "../src/model-provider/stepCommunityModelSelection.js";
import {
  fetchStepAccountBalance,
  writeStepDesktopCredential,
} from "../src/model-provider/stepCommunityApiKey.js";
import { createStepCommunityService } from "../src/model-provider/stepCommunityModelSelectionRuntime.js";

/** 单测专用占位 key：由非敏感标记片段运行时拼出（非凭据字面量，也不会发往任何端点）。 */
const FAKE_TEST_KEY = ["stepcommunity", "unit-test", "placeholder"].join(":");

/** 返回固定 JSON 体的 fetch 桩（不发起任何真实网络请求）。 */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** 返回原始响应体文本的 fetch 桩：用于把 JSON 不支持的值（NaN/Infinity）送进解析路径。 */
function rawFetch(raw: string, status = 200): typeof fetch {
  return (async () => new Response(raw, { status })) as unknown as typeof fetch;
}

/** 最小基线 modelSelection：getAccountBalance 不读 view，占位即可。 */
function makeFakeModelSelection(): IModelSelectionService {
  return {
    onDidChange: () => ({ dispose: () => undefined }),
    getView: async (): Promise<ModelSelectionView> => ({ revision: 1, providers: [] }),
  };
}

/** 临时替换 globalThis.fetch（service 层没有 fetchImpl 注入口）；用完必还原。 */
async function withStubbedFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("fetchStepAccountBalance：成功时只解析 type/balance/total_cash_balance/total_voucher_balance 四个原始字段", async () => {
  const result = await fetchStepAccountBalance(FAKE_TEST_KEY, {
    fetchImpl: jsonFetch({
      object: "account",
      id: "should-not-be-projected",
      type: "postpaid",
      balance: 1234.5,
      total_cash_balance: 1000,
      total_voucher_balance: 234.56,
    }),
  });
  assert.deepEqual(result, {
    status: "ok",
    httpStatus: 200,
    accountType: "postpaid",
    balance: 1234.5,
    totalCashBalance: 1000,
    totalVoucherBalance: 234.56,
  });
});

test("fetchStepAccountBalance：余额为 0 与预付费类型如实保留（不隐藏、不改写）", async () => {
  const result = await fetchStepAccountBalance(FAKE_TEST_KEY, {
    fetchImpl: jsonFetch({ type: "prepaid", balance: 0 }),
  });
  assert.deepEqual(result, { status: "ok", httpStatus: 200, accountType: "prepaid", balance: 0 });
});

test("fetchStepAccountBalance：缺失字段缺省，type 非枚举值时不猜 accountType", async () => {
  const result = await fetchStepAccountBalance(FAKE_TEST_KEY, {
    fetchImpl: jsonFetch({ type: "future-kind", balance: 10 }),
  });
  assert.deepEqual(result, { status: "ok", httpStatus: 200, balance: 10 });
  // 完全空 object 也是合法响应体：ok 但四个投影字段全缺省（UI 走 empty 占位）。
  const empty = await fetchStepAccountBalance(FAKE_TEST_KEY, { fetchImpl: jsonFetch({}) });
  assert.deepEqual(empty, { status: "ok", httpStatus: 200 });
});

test("fetchStepAccountBalance：负值/非有限金额字段被舍弃", async () => {
  // JSON 表示不了 NaN（字面量 NaN 会让整个响应体变成非法 JSON，走 network 分支）；
  // 非有限值里只有 Infinity 能经合法 JSON 到达（1e999 解析为 Infinity），负数同样可经 JSON 到达。
  // readNonNegativeAmount 对 NaN/±Infinity/负数/非 number 一视同仁地舍弃，这里覆盖可经 JSON 到达的分支。
  const result = await fetchStepAccountBalance(FAKE_TEST_KEY, {
    fetchImpl: rawFetch('{"type":"prepaid","balance":-1,"total_cash_balance":1e999}'),
  });
  assert.deepEqual(result, { status: "ok", httpStatus: 200, accountType: "prepaid" });
  // 字符串金额同样不当作数字下发。
  const stringAmount = await fetchStepAccountBalance(FAKE_TEST_KEY, {
    fetchImpl: jsonFetch({ balance: "12.5" }),
  });
  assert.deepEqual(stringAmount, { status: "ok", httpStatus: 200 });
});

test("fetchStepAccountBalance：401/403 → invalid，其它非 2xx → network（均带 httpStatus）", async () => {
  for (const status of [401, 403]) {
    const result = await fetchStepAccountBalance(FAKE_TEST_KEY, { fetchImpl: jsonFetch({}, status) });
    assert.deepEqual(result, { status: "invalid", httpStatus: status });
  }
  for (const status of [400, 429, 500, 503]) {
    const result = await fetchStepAccountBalance(FAKE_TEST_KEY, { fetchImpl: jsonFetch({}, status) });
    assert.deepEqual(result, { status: "network", httpStatus: status });
  }
});

test("fetchStepAccountBalance：fetch 抛错 → network + errorName，不解析 body", async () => {
  const thrower = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const result = await fetchStepAccountBalance(FAKE_TEST_KEY, { fetchImpl: thrower });
  assert.equal(result.status, "network");
  assert.equal(result.httpStatus, null);
  assert.equal(result.errorName, "TypeError");
  // 非 Error 抛出：errorName 缺省，仍归一为 network（断网不能变成 invalid 锁人）。
  const nonError = (async () => {
    throw "boom";
  }) as unknown as typeof fetch;
  const nonErrorResult = await fetchStepAccountBalance(FAKE_TEST_KEY, { fetchImpl: nonError });
  assert.equal(nonErrorResult.status, "network");
  assert.equal(nonErrorResult.errorName, undefined);
});

test("fetchStepAccountBalance：响应体非法 → network（不猜结构、不给兜底金额）", async () => {
  for (const raw of ["not-json{{", "[]", '"text"', "null", "123"]) {
    const result = await fetchStepAccountBalance(FAKE_TEST_KEY, { fetchImpl: rawFetch(raw) });
    assert.deepEqual(result, { status: "network", httpStatus: 200 }, `expected network for: ${raw}`);
  }
});

test("fetchStepAccountBalance：请求 URL/方法/头强校验，redirect=error，10s 超时", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const capturing = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await fetchStepAccountBalance(FAKE_TEST_KEY, { fetchImpl: capturing });
  assert.equal(captured?.url, "https://api.stepfun.com/v1/accounts");
  assert.equal(captured?.init.method, "GET");
  assert.deepEqual(captured?.init.headers, {
    accept: "application/json",
    authorization: `Bearer ${FAKE_TEST_KEY}`,
  });
  // redirect:"error"：任何 3xx 直接抛错，Authorization 头绝无机会被带到重定向目标。
  assert.equal(captured?.init.redirect, "error");
  const signal = captured?.init.signal as AbortSignal;
  assert.equal(signal.aborted, false);
});

test("fetchStepAccountBalance：空 key 直接 no-key，不发任何请求", async () => {
  let fetchCalled = false;
  const counting = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchStepAccountBalance("   ", { fetchImpl: counting }), {
    status: "no-key",
    httpStatus: null,
  });
  assert.equal(fetchCalled, false);
});

test("service.getAccountBalance：无可用 key → no-key 且不发请求", async () => {
  const dir = await mkdtemp(join(tmpdir(), "step-balance-nokey-"));
  try {
    let fetchCalled = false;
    const counting = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    // STEPCODE_AUTH_PATH 指向不存在的临时文件，保证 readStepApiKey 一定落到 source=none。
    const env: Record<string, string | undefined> = {
      STEP_BACKEND: "stepcode-local",
      STEP_API_KEY: "",
      STEPCODE_AUTH_PATH: join(dir, "missing-auth.json"),
    };
    await withStubbedFetch(counting, async () => {
      const service = createStepCommunityService({ env, modelSelection: makeFakeModelSelection() });
      assert.deepEqual(await service.getAccountBalance(), { status: "no-key" });
    });
    assert.equal(fetchCalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service.getAccountBalance：仅订阅 Key 时返回 no-key，不拿订阅 Key 查询 API 余额", async () => {
  const dir = await mkdtemp(join(tmpdir(), "step-balance-sub-"));
  try {
    let fetchCalled = false;
    const counting = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const env: Record<string, string | undefined> = {
      STEP_BACKEND: "stepcode-local",
      STEPCODE_DESKTOP_CREDENTIALS: join(dir, "keys.json"),
      STEPCODE_AUTH_PATH: join(dir, "missing-auth.json"),
    };
    await writeStepDesktopCredential(env, FAKE_TEST_KEY, "subscription");
    await withStubbedFetch(counting, async () => {
      const service = createStepCommunityService({ env, modelSelection: makeFakeModelSelection() });
      assert.deepEqual(await service.getAccountBalance(), { status: "no-key" });
    });
    assert.equal(fetchCalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service.getAccountBalance：api 连接模式且已配置 key 时发请求并透传解析结果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "step-balance-api-"));
  try {
    const env: Record<string, string | undefined> = {
      STEP_BACKEND: "stepcode-local",
      STEP_API_KEY: FAKE_TEST_KEY,
      STEPCODE_AUTH_PATH: join(dir, "missing-auth.json"),
    };
    await withStubbedFetch(jsonFetch({ type: "prepaid", balance: 42 }), async () => {
      const service = createStepCommunityService({ env, modelSelection: makeFakeModelSelection() });
      const balance: StepCommunityBalance = await service.getAccountBalance();
      assert.deepEqual(balance, { status: "ok", httpStatus: 200, accountType: "prepaid", balance: 42 });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
