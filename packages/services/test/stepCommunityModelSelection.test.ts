import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ModelSelectionView, ModelSelectionViewInput } from "@zcode/provider";
import type { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import {
  STEP_COMMUNITY_MODEL_ID,
  STEP_COMMUNITY_PROVIDER_ID,
  STEP_COMMUNITY_PROVIDER_TEMPLATE_ID,
  STEP_API_PROVIDER_ID,
  isStepCommunityBackendActive,
} from "../src/model-provider/stepCommunityModelSelection.js";
import {
  createStepCommunityService,
  wrapModelSelectionServiceForStepCommunity,
  type StepAwareModelSelectionService,
} from "../src/model-provider/stepCommunityModelSelectionRuntime.js";
import {
  assertStepApiUrl,
  readStepApiKey,
  resetStepAuthFileCredentialCacheForTest,
  validateStepApiKey,
  writeStepApiKeyToAuthFile,
  resolveStepAuthFilePath,
} from "../src/model-provider/stepCommunityApiKey.js";

/** 单测专用占位 key：由非敏感标记片段运行时拼出（非凭据字面量，绝不可能是真实凭据，也不会发往任何端点——校验用的 fetch 均为本地桩）。 */
const FAKE_TEST_KEY = ["stepcommunity", "unit-test", "placeholder"].join(":");
const FAKE_TEST_KEY_PADDED = `  ${FAKE_TEST_KEY}  `;
const FAKE_TEST_KEY_TRIMMED = FAKE_TEST_KEY_PADDED.trim();

function makeBaseView(overrides: Partial<ModelSelectionView> = {}): ModelSelectionView {
  return Object.freeze({
    revision: 7,
    providers: Object.freeze([]),
    ...overrides,
  });
}

/** 最小基线 service：返回固定 view，并模拟 registry 变化事件。 */
function makeFakeBaseService(initial: ModelSelectionView): IModelSelectionService & {
  emitChange(next: ModelSelectionView): void;
  baseListeners: Set<(view: ModelSelectionView) => void>;
} {
  let current = initial;
  const baseListeners = new Set<(view: ModelSelectionView) => void>();
  return {
    onDidChange: (listener) => {
      baseListeners.add(listener);
      return { dispose: () => baseListeners.delete(listener) };
    },
    getView: async (_input?: ModelSelectionViewInput) => current,
    baseListeners,
    emitChange(next: ModelSelectionView) {
      current = next;
      for (const listener of baseListeners) listener(next);
    },
  };
}

function communityEnv(overrides: Record<string, string | string | undefined> = {}): Record<
  string,
  string | undefined
> {
  return { STEP_BACKEND: "stepcode-local", STEP_API_KEY: FAKE_TEST_KEY, ...overrides };
}

test("isStepCommunityBackendActive 只认精确开关值", () => {
  assert.equal(isStepCommunityBackendActive({ STEP_BACKEND: "stepcode-local" }), true);
  assert.equal(isStepCommunityBackendActive({ STEP_BACKEND: " stepcode-local " }), true);
  assert.equal(isStepCommunityBackendActive({}), false);
  assert.equal(isStepCommunityBackendActive({ STEP_BACKEND: "" }), false);
  assert.equal(isStepCommunityBackendActive({ STEP_BACKEND: "stepcode-local-x" }), false);
  assert.equal(isStepCommunityBackendActive({ STEP_BACKEND: "stepcode" }), false);
});

test("未设置 STEP_BACKEND 时 wrap 返回原 service 引用（上游零包装）", () => {
  const base = makeFakeBaseService(makeBaseView());
  const wrapped = wrapModelSelectionServiceForStepCommunity(base, {
    env: { STEP_BACKEND: undefined, STEP_API_KEY: FAKE_TEST_KEY },
  });
  assert.equal(wrapped, base);
});

test("STEP_BACKEND 命中且有 env key 时 getView 注入 step provider 并兜底 preferredSelection", async () => {
  const base = makeFakeBaseService(makeBaseView({ revision: 7, providers: [] }));
  const wrapped = wrapModelSelectionServiceForStepCommunity(base, {
    env: communityEnv(),
  });
  const view = await wrapped.getView();
  assert.equal(view.providers.length, 2);
  const step = view.providers[0]!;
  assert.equal(step.providerId, STEP_COMMUNITY_PROVIDER_ID);
  assert.equal(step.templateId, STEP_COMMUNITY_PROVIDER_TEMPLATE_ID);
  assert.equal(step.models[0]?.modelId, STEP_COMMUNITY_MODEL_ID);
  // access 不携带任何 key 形态：真实 key 只经 env/auth.json 被 bridge/CLI 消费。
  assert.deepEqual(step.config.access, { type: "api-key" });
  assert.equal(step.config.visibility, "hidden");
  // preferredSelection 兜底与桥默认一致。
  assert.deepEqual(view.preferredSelection, {
    providerId: STEP_API_PROVIDER_ID,
    modelId: STEP_COMMUNITY_MODEL_ID,
  });
  // revision 单调且不低于基线。
  assert.ok(view.revision >= 7);
});

test("STEP_BACKEND 命中但没有任何 key 时不注入（view 原样透传）", async () => {
  const baseView = makeBaseView({ providers: [] });
  const base = makeFakeBaseService(baseView);
  const env: Record<string, string | undefined> = communityEnv({ STEP_API_KEY: "" });
  // 用临时 auth.json 覆盖路径，避免读到真实 ~/.stepcode/auth.json。
  const dir = await mkdtemp(join(tmpdir(), "stepcommunity-test-"));
  try {
    env.STEPCODE_AUTH_PATH = join(dir, "auth.json");
    const wrapped = wrapModelSelectionServiceForStepCommunity(base, { env });
    const view = await wrapped.getView();
    assert.equal(view.providers.length, 0);
    assert.equal(view.preferredSelection, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("注入后撤除（setInjectionActive false）回退基线透传且 revision 单调不回退", async () => {
  const baseView = makeBaseView({ revision: 9, providers: [] });
  const base = makeFakeBaseService(baseView);
  const wrapped = wrapModelSelectionServiceForStepCommunity(base, {
    env: communityEnv(),
  }) as StepAwareModelSelectionService;
  const injectedView = await wrapped.getView();
  assert.equal(injectedView.providers.length, 2);
  wrapped.setInjectionActive(false, "api-key-invalid");
  assert.equal(wrapped.isInjectionActive, false);
  const retractedView = await wrapped.getView();
  assert.equal(retractedView.providers.length, 0);
  // renderer 的 latestRevision 只增不减：撤除后的 revision 必须 ≥ 注入期 revision，
  // 否则 retraction 视图会被 renderer 按"陈旧视图"丢弃，欢迎页门无法重新打开。
  assert.ok(retractedView.revision >= injectedView.revision);
  // 再注入（表单写入新 key 后的激活路径）revision 必须严格大于撤除前后的所有视图。
  wrapped.setInjectionActive(true, "api-key-stored");
  const reactivatedView = await wrapped.getView();
  assert.equal(reactivatedView.providers.length, 2);
  assert.ok(reactivatedView.revision > retractedView.revision);
  assert.ok(reactivatedView.revision > injectedView.revision);
});

test("指向 step 的 input selection 由注入层本地投影 effectiveSelection", async () => {
  const base = makeFakeBaseService(makeBaseView({ providers: [] }));
  const wrapped = wrapModelSelectionServiceForStepCommunity(base, {
    env: communityEnv(),
  });
  // 模型命中 + 合法档位 → 完整解析。
  const ok = await wrapped.getView({
    selection: {
      providerId: STEP_COMMUNITY_PROVIDER_ID,
      modelId: STEP_COMMUNITY_MODEL_ID,
      options: { reasoningLevel: "enabled" },
    },
  });
  assert.deepEqual(ok.effectiveSelection, {
    providerId: STEP_COMMUNITY_PROVIDER_ID,
    modelId: STEP_COMMUNITY_MODEL_ID,
    options: { reasoningLevel: "enabled" },
  });
  assert.equal(ok.selectionIssue, undefined);
  // 模型不存在 → selectionIssue=model-not-found 且保留 effectiveSelection 主体。
  const modelMissing = await wrapped.getView({
    selection: { providerId: STEP_COMMUNITY_PROVIDER_ID, modelId: "other-model" },
  });
  assert.equal(modelMissing.selectionIssue, "model-not-found");
  assert.equal(modelMissing.effectiveSelection?.modelId, "other-model");
  // 缺档位 → reasoning-level-missing。
  const levelMissing = await wrapped.getView({
    selection: { providerId: STEP_COMMUNITY_PROVIDER_ID, modelId: STEP_COMMUNITY_MODEL_ID },
  });
  assert.equal(levelMissing.selectionIssue, "reasoning-level-missing");
  // 非法档位 → reasoning-level-not-supported。
  const levelBad = await wrapped.getView({
    selection: {
      providerId: STEP_COMMUNITY_PROVIDER_ID,
      modelId: STEP_COMMUNITY_MODEL_ID,
      options: { reasoningLevel: "turbo" },
    },
  });
  assert.equal(levelBad.selectionIssue, "reasoning-level-not-supported");
});

test("非 step 的 input selection 与基线 preferredSelection 保持原样（上游语义零改动）", async () => {
  const base = makeFakeBaseService(
    makeBaseView({
      preferredSelection: { providerId: "official", modelId: "glm" },
      effectiveSelection: null,
      selectionIssue: "provider-not-found",
      providers: [],
    }),
  );
  const wrapped = wrapModelSelectionServiceForStepCommunity(base, {
    env: communityEnv(),
  });
  const view = await wrapped.getView({
    selection: { providerId: "official", modelId: "glm" },
  });
  // 基线已有的 preferredSelection 优先于注入兜底。
  assert.deepEqual(view.preferredSelection, { providerId: "official", modelId: "glm" });
  // 非 step 选择的有效性判定字段原样透传。
  assert.equal(view.effectiveSelection, null);
  assert.equal(view.selectionIssue, "provider-not-found");
});

test("基线 registry 事件经注入包装重投影转发给订阅者", async () => {
  const base = makeFakeBaseService(makeBaseView({ revision: 1, providers: [] }));
  const wrapped = wrapModelSelectionServiceForStepCommunity(base, {
    env: communityEnv(),
  });
  const received: ModelSelectionView[] = [];
  const subscription = wrapped.onDidChange((view) => received.push(view));
  base.emitChange(makeBaseView({ revision: 2, providers: [] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.providers.length, 2);
  assert.equal(received[0]?.providers[0]?.providerId, STEP_COMMUNITY_PROVIDER_ID);
  subscription.dispose();
});

test("assertStepApiUrl 仅允许 https + host 精确等于 api.stepfun.com", () => {
  assert.equal(assertStepApiUrl("https://api.stepfun.com/v1/models").hostname, "api.stepfun.com");
  // 非白名单 host（含环回/私网/保留/子域/变体写法）一律抛错。
  for (const bad of [
    "http://api.stepfun.com/v1/models", // 非 https
    "https://localhost/v1/models",
    "https://127.0.0.1/v1/models",
    "https://127.0.0.1:8080/v1/models",
    "https://[::1]/v1/models",
    "https://10.0.0.1/v1/models",
    "https://192.168.1.1/v1/models",
    "https://169.254.169.254/v1/models",
    "https://0.0.0.0/v1/models",
    "https://evil-api.stepfun.com.attacker.example/v1/models", // 后缀伪装
    "https://api.stepfun.com.attacker.example/v1/models", // 点号连写伪装
    "https://x-api.stepfun.com/v1/models", // 子域
    "https://API.STEPFUN.COM.evil.example/v1/models",
    "file:///C:/Windows/system32/config",
    "not-a-url",
    "",
  ]) {
    assert.throws(() => assertStepApiUrl(bad), undefined, `expected rejection: ${bad}`);
  }
  // WHATWG URL 会归一大小写，真实 host 白名单匹配不受大小写影响。
  assert.equal(assertStepApiUrl("https://API.STEPFUN.COM/v1/models").hostname, "api.stepfun.com");
});

test("validateStepApiKey 分类：401/403 → invalid，其余非 2xx/网络异常 → network，200 → valid", async () => {
  // 注：204 等无 body 状态码不能用带 body 的 Response 构造（构造器会抛 TypeError），这里用 200/201 代表 ok 档。
  const status = (code: number) => async () => new Response("{}", { status: code });
  assert.equal((await validateStepApiKey(FAKE_TEST_KEY, { fetchImpl: status(401) })).validity, "invalid");
  assert.equal((await validateStepApiKey(FAKE_TEST_KEY, { fetchImpl: status(403) })).validity, "invalid");
  assert.equal((await validateStepApiKey(FAKE_TEST_KEY, { fetchImpl: status(500) })).validity, "network");
  assert.equal((await validateStepApiKey(FAKE_TEST_KEY, { fetchImpl: status(200) })).validity, "valid");
  assert.equal(
    (await validateStepApiKey(FAKE_TEST_KEY, { fetchImpl: status(201) })).validity,
    "valid",
  );
  const networkError = async () => {
    throw new TypeError("fetch failed");
  };
  const networkResult = await validateStepApiKey(FAKE_TEST_KEY, {
    fetchImpl: networkError as never,
  });
  assert.equal(networkResult.validity, "network");
  assert.equal(networkResult.errorName, "TypeError");
  // 空 key 直接判 invalid，且不发起任何网络请求。
  let fetchCalled = false;
  const counting = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal((await validateStepApiKey("  ", { fetchImpl: counting })).validity, "invalid");
  assert.equal(fetchCalled, false);
  // 请求头与 CLI 完全同款。
  let captured: { url: string; init: RequestInit } | undefined;
  const capturing = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await validateStepApiKey(FAKE_TEST_KEY_PADDED, { fetchImpl: capturing });
  assert.equal(captured?.url, "https://api.stepfun.com/v1/models");
  assert.equal(captured?.init.method, "GET");
  assert.deepEqual(captured?.init.headers, {
    accept: "application/json",
    authorization: `Bearer ${FAKE_TEST_KEY_TRIMMED}`,
  });
  assert.ok((captured?.init.signal as AbortSignal).aborted === false);
  // 评审加固：host 白名单只校验字面量 URL，不覆盖重定向目标；redirect:"error" 让任何 3xx
  // 直接抛错（validateStepApiKey 归一为 network），Authorization 头绝无机会被携带到重定向目标。
  assert.equal(captured?.init.redirect, "error");
});

test("readStepApiKey：env 优先；STEPCODE_AUTH_PATH 覆盖 auth.json 路径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stepcommunity-auth-"));
  const authPath = join(dir, "auth.json");
  try {
    await writeFile(
      authPath,
      JSON.stringify({
        "other-provider": { type: "api_key", key: "other" },
        step: { type: "api_key", key: `  ${["file", "level", "key"].join(":")}  `, profile: "platform_cn" },
      }),
      "utf8",
    );
    // env 优先于 file。
    assert.deepEqual(readStepApiKey({ STEP_API_KEY: FAKE_TEST_KEY, STEPCODE_AUTH_PATH: authPath }), {
      key: FAKE_TEST_KEY,
      source: "env",
    });
    // env 缺失回落 file，且 trim。
    assert.deepEqual(readStepApiKey({ STEPCODE_AUTH_PATH: authPath }), {
      key: ["file", "level", "key"].join(":"),
      source: "file",
    });
    // 非 api_key 形状（oauth 档）不算可用 key。
    await writeFile(authPath, JSON.stringify({ step: { type: "oauth", access: "x" } }), "utf8");
    assert.deepEqual(readStepApiKey({ STEPCODE_AUTH_PATH: authPath }), {
      key: undefined,
      source: "none",
    });
    // 文件缺失同样视为 none。
    assert.deepEqual(
      readStepApiKey({ STEPCODE_AUTH_PATH: join(dir, "missing-auth.json") }),
      { key: undefined, source: "none" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeStepApiKeyToAuthFile：只替换 step 键、保留其它 provider；畸形文件拒绝覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stepcommunity-write-"));
  const authPath = join(dir, "auth.json");
  const newKey = ["new", "file", "key"].join(":");
  try {
    await writeFile(
      authPath,
      JSON.stringify({
        "other-provider": { type: "api_key", key: ["keep", "other"].join(":") },
        step: { type: "api_key", key: ["old", "key"].join(":"), profile: "platform_cn" },
      }),
      "utf8",
    );
    await writeStepApiKeyToAuthFile({ STEPCODE_AUTH_PATH: authPath }, ` ${newKey} `);
    const parsed = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(parsed["other-provider"], {
      type: "api_key",
      key: ["keep", "other"].join(":"),
    });
    assert.deepEqual(parsed.step, { type: "api_key", key: newKey, profile: "platform_cn" });
    // 写盘后同进程读取立即看到新 key（读缓存已失效重建）。
    assert.deepEqual(readStepApiKey({ STEPCODE_AUTH_PATH: authPath }), {
      key: newKey,
      source: "file",
    });
    // 畸形 JSON：显式报错且不覆盖（保护其它 provider 凭据）。
    await writeFile(authPath, "{corrupted", "utf8");
    await assert.rejects(
      writeStepApiKeyToAuthFile({ STEPCODE_AUTH_PATH: authPath }, ["another", "one"].join(":")),
      /已损坏/,
    );
    assert.equal(await readFile(authPath, "utf8"), "{corrupted");
    // 空 key 拒绝写入。
    await assert.rejects(writeStepApiKeyToAuthFile({ STEPCODE_AUTH_PATH: authPath }, "  "));
  } finally {
    resetStepAuthFileCredentialCacheForTest();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveStepAuthFilePath 镜像 CLI 的路径解析链", () => {
  // 期望值一律经 join()/resolve() 生成：断言的是解析链路本身，不绑定平台分隔符。
  assert.equal(
    resolveStepAuthFilePath({ STEPCODE_AUTH_PATH: "  /custom/auth.json  " }),
    "/custom/auth.json",
  );
  assert.equal(
    resolveStepAuthFilePath({ HOME: "/home/u", STEPCODE_CONFIG_DIR: ".stepcode" }),
    join("/home/u", ".stepcode", "auth.json"),
  );
  // STEP_CODING_AGENT_DIR 覆盖时取其父目录（与 CLI 的 resolve + dirname 行为一致）。
  assert.equal(
    resolveStepAuthFilePath({
      HOME: "/home/u",
      STEPCODE_CONFIG_DIR: ".stepcode",
      STEP_CODING_AGENT_DIR: "/agent/dir",
    }),
    join(resolve("/agent/dir"), "..", "auth.json"),
  );
  assert.equal(
    resolveStepAuthFilePath({ HOME: undefined, USERPROFILE: "C:\\Users\\u" }),
    join("C:\\Users\\u", ".stepcode", "auth.json"),
  );
});

test("validateStepApiKey 顺带解析 modelIds：data[].id 提取；畸形 body 不影响 validity", async () => {
  const jsonResponse = (obj: unknown, status = 200) =>
    async () => new Response(JSON.stringify(obj), { status });
  // 正常清单：非字符串/无 id/空 id 的条目被跳过。
  const listed = await validateStepApiKey(FAKE_TEST_KEY, {
    fetchImpl: jsonResponse({
      object: "list",
      data: [{ id: "step-5-preview" }, { id: "step-1o-turbo-vision" }, { noId: true }, null, { id: "  " }],
    }),
  });
  assert.equal(listed.validity, "valid");
  assert.deepEqual(listed.modelIds, ["step-5-preview", "step-1o-turbo-vision"]);
  // data 为空数组：modelIds 是空数组（解析成功、清单为空）。
  const empty = await validateStepApiKey(FAKE_TEST_KEY, {
    fetchImpl: jsonResponse({ object: "list", data: [] }),
  });
  assert.deepEqual(empty.modelIds, []);
  // 非 JSON body：modelIds undefined，validity 仍 valid（探测失败不影响校验结论）。
  const malformed = await validateStepApiKey(FAKE_TEST_KEY, {
    fetchImpl: async () => new Response("not-json{{", { status: 200 }),
  });
  assert.equal(malformed.validity, "valid");
  assert.equal(malformed.modelIds, undefined);
  // data 非数组（形状异常）：modelIds undefined。
  const weirdShape = await validateStepApiKey(FAKE_TEST_KEY, {
    fetchImpl: jsonResponse({ object: "list", data: { id: "x" } }),
  });
  assert.equal(weirdShape.validity, "valid");
  assert.equal(weirdShape.modelIds, undefined);
  // 401 不解析 body：invalid 且无 modelIds。
  const invalid = await validateStepApiKey(FAKE_TEST_KEY, {
    fetchImpl: jsonResponse({ data: [{ id: "x" }] }, 401),
  });
  assert.equal(invalid.validity, "invalid");
  assert.equal(invalid.modelIds, undefined);
});

/** 临时替换 globalThis.fetch（后台复核/登录路径无 fetchImpl 注入口）；用完必还原。 */
async function withStubbedFetch<T>(body: unknown, status: number, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  globalThis.fetch = (async () => new Response(payload, { status })) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("后台复核：/models 不含 step-5-preview 时注入默认切到 step-1o-turbo-vision（view 同步）", async () => {
  await withStubbedFetch({ object: "list", data: [{ id: "unrelated" }, { id: "step-1o-turbo-vision" }] }, 200, async () => {
    const base = makeFakeBaseService(makeBaseView({ providers: [] }));
    const wrapped = wrapModelSelectionServiceForStepCommunity(base, {
      env: communityEnv(),
    }) as StepAwareModelSelectionService;
    wrapped.startBackgroundKeyValidationOnce();
    // 后台复核是 fire-and-forget：轮询投影直到默认切换或超时。
    const deadline = Date.now() + 5000;
    let view = await wrapped.getView();
    while (view.preferredSelection?.modelId !== "step-1o-turbo-vision" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      view = await wrapped.getView();
    }
    assert.equal(view.preferredSelection?.modelId, "step-1o-turbo-vision");
    // provider view 的模型清单与默认一致（否则渲染端会出现 model-not-found 假象）。
    assert.equal(view.providers[0]?.models[0]?.modelId, "step-1o-turbo-vision");
    assert.deepEqual(view.providers[0]?.config.builtinModelIds, ["step-1o-turbo-vision"]);
    // 指向新默认的 selection 解析不再报 model-not-found（带合法档位）。
    const resolved = await wrapped.getView({
      selection: {
        providerId: STEP_COMMUNITY_PROVIDER_ID,
        modelId: "step-1o-turbo-vision",
        options: { reasoningLevel: "disabled" },
      },
    });
    assert.equal(resolved.selectionIssue, undefined);
  });
});

test("后台复核：交集为空时维持默认 step-5-preview", async () => {
  await withStubbedFetch({ object: "list", data: [{ id: "unrelated-model" }] }, 200, async () => {
    const base = makeFakeBaseService(makeBaseView({ providers: [] }));
    const wrapped = wrapModelSelectionServiceForStepCommunity(base, {
      env: communityEnv(),
    }) as StepAwareModelSelectionService;
    wrapped.startBackgroundKeyValidationOnce();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const view = await wrapped.getView();
    assert.equal(view.preferredSelection?.modelId, STEP_COMMUNITY_MODEL_ID);
    assert.equal(view.providers[0]?.models[0]?.modelId, STEP_COMMUNITY_MODEL_ID);
  });
});

test("登录表单校验：validateAndStoreApiKey 按 /models 交集切换默认并落盘新 key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stepcommunity-login-"));
  try {
    const authPath = join(dir, "auth.json");
    await withStubbedFetch({ object: "list", data: [{ id: "step-1o-turbo-vision" }] }, 200, async () => {
      const base = makeFakeBaseService(makeBaseView({ providers: [] }));
      const env = { STEP_BACKEND: "stepcode-local", STEPCODE_AUTH_PATH: authPath } as Record<
        string,
        string | undefined
      >;
      const wrapped = wrapModelSelectionServiceForStepCommunity(base, { env });
      const service = createStepCommunityService({ env, modelSelection: wrapped });
      const outcome = await service.validateAndStoreApiKey({ apiKey: FAKE_TEST_KEY });
      assert.deepEqual(outcome, { ok: true });
      const view = await wrapped.getView();
      assert.equal(view.preferredSelection?.modelId, "step-1o-turbo-vision");
      assert.equal(view.providers.length, 2);
    });
    // key 落盘到覆盖路径（不碰真实 auth.json）。
    assert.deepEqual(readStepApiKey({ STEPCODE_AUTH_PATH: authPath }), {
      key: FAKE_TEST_KEY,
      source: "file",
    });
  } finally {
    resetStepAuthFileCredentialCacheForTest();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getStatus 尾号派生：仅社区模式携带尾 4 位，完整 key 绝不进返回值", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stepcommunity-status-"));
  try {
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify({}), "utf8");
    // 单测专用占位 key（非凭据字面量，运行时拼出，与 FAKE_TEST_KEY 同款纪律）。
    const fakeEnvKey = ["stepcommunity", "unit-test", "placeholder", "tail", "abcd"].join(":");
    const base = makeFakeBaseService(makeBaseView({ providers: [] }));
    const communityEnvWithKey = {
      STEP_BACKEND: "stepcode-local",
      STEPCODE_AUTH_PATH: authPath,
      STEP_API_KEY: fakeEnvKey,
    } as Record<string, string | undefined>;
    const active = await createStepCommunityService({
      env: communityEnvWithKey,
      modelSelection: wrapModelSelectionServiceForStepCommunity(base, {
        env: communityEnvWithKey,
      }),
    }).getStatus();
    assert.equal(active.active, true);
    assert.equal(active.keySource, "env");
    // 只带尾 4 位掩码；完整 key 不得出现在返回值里。
    assert.equal(active.apiKeyTail, "abcd");
    assert.ok(!JSON.stringify(active).includes(fakeEnvKey));

    // 非社区模式（不设 STEP_BACKEND）：即使 env 有 key 也不带尾号（上游零信息面）。
    const inactive = await createStepCommunityService({
      env: { STEPCODE_AUTH_PATH: authPath, STEP_API_KEY: fakeEnvKey },
      modelSelection: base,
    }).getStatus();
    assert.equal(inactive.active, false);
    assert.equal(inactive.keySource, "env");
    assert.equal(inactive.apiKeyTail, undefined);

    // 社区模式但无 key：无尾号，keySource=none。
    const noKey = await createStepCommunityService({
      env: { STEP_BACKEND: "stepcode-local", STEPCODE_AUTH_PATH: authPath },
      modelSelection: base,
    }).getStatus();
    assert.equal(noKey.active, true);
    assert.equal(noKey.keySource, "none");
    assert.equal(noKey.apiKeyTail, undefined);
  } finally {
    resetStepAuthFileCredentialCacheForTest();
    await rm(dir, { recursive: true, force: true });
  }
});
