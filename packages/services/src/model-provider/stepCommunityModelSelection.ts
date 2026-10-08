/*
 * Step-Code (community) 的模型选择注入层 —— browser-safe 类型面与纯投影形状。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 * Community-maintained integration; not affiliated with or endorsed by Z.ai.
 *
 * 本文件必须保持 browser-safe（renderer 经根 index.ts 拉进浏览器包）：
 * 只放 descriptor、类型、纯常量与纯投影形状；依赖 node:fs/fetch 的读取、校验、
 * 落盘与运行时包装在 stepCommunityApiKey.ts / stepCommunityModelSelectionRuntime.ts（host-only）。
 *
 * 设计（纯加法）：唯一激活条件是 STEP_BACKEND=stepcode-local；不命中时运行时包装层
 * 原样返回 base service 引用（零包装、零行为差异），上游路径零改动。命中且有可用 key
 * （STEP_API_KEY env 或 auth.json step 条目）时，getView/onDidChange 在官方 view.providers
 * 尾部追加一个内存态 step provider（providerId="step"、templateId="stepcode-community"、
 * models=[step-5-preview]，与桥默认一致），view 无 preferredSelection 时补
 * {providerId:"step",modelId:"step-5-preview"}。两级语义：有 key 即乐观注入；host 启动后
 * 异步校验复核，仅 401/403 才撤注入并 bump（欢迎页重新弹出引导重填），网络错误/5xx
 * 保持乐观（断网不锁人）。
 */
import { ServiceChannels } from "@zcode/shared";
import type { ModelSelection, ModelSelectionProviderView } from "@zcode/provider";
import { createServiceDescriptor } from "../descriptors.js";

/** 开关键与取值（canonical 定义：packages/desktop/src/main/stepcodeBackend.ts:19-20；desktop → services 是唯一依赖方向，故在此复制字面量并互指）。 */
export const STEP_BACKEND_ENV = "STEP_BACKEND";
export const STEP_BACKEND_COMMUNITY_VALUE = "stepcode-local";
/** Step CLI 认的环境变量 key（启动器从 step.env 的 STEPFUN_API_KEY 复制而来）。 */
export const STEP_API_KEY_ENV = "STEP_API_KEY";

/** 注入的社区 provider 标识（providerId 与 Step CLI 的 provider 命名一致；templateId 为社区标记）。 */
export const STEP_COMMUNITY_PROVIDER_ID = "step";
export const STEP_API_PROVIDER_ID = "step-api";
export const STEP_PLAN_PROVIDER_ID = "step-plan";
export const STEP_COMMUNITY_PROVIDER_TEMPLATE_ID = "stepcode-community";
export const STEP_COMMUNITY_PROVIDER_NAME = "阶跃星辰";
export const STEP_COMMUNITY_MODEL_ID = "step-5-preview";
/** 注入 provider 的默认选择（与 stepcode-adapter 桥的 defaultModelSelection 一致，不带 reasoning 档位）。 */
export const STEP_COMMUNITY_DEFAULT_SELECTION: ModelSelection = Object.freeze({
  providerId: STEP_COMMUNITY_PROVIDER_ID,
  modelId: STEP_COMMUNITY_MODEL_ID,
});

/** Step 平台大陆 API 端点（与 CLI platform_cn profile 同源，仅作 provider 展示位 config）。 */
export const STEP_COMMUNITY_API_BASE_URL = "https://api.stepfun.com/v1";

export type StepEnvRecord = Record<string, string | undefined>;

/** STEP_BACKEND=stepcode-local 时社区模式生效（与 desktop main stepcodeBackend.ts 同一开关语义）。 */
export function isStepCommunityBackendActive(env: StepEnvRecord): boolean {
  return env[STEP_BACKEND_ENV]?.trim() === STEP_BACKEND_COMMUNITY_VALUE;
}

/** 注入模型档位的完整 optionSpecs 形状（对齐 serializeRegistryModelConfig 的输出字段）。 */
export function createStepCommunityModelConfig() {
  return Object.freeze({
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      // Step CLI 对 step 模型族的 contextWindow 兜底是 256_000（providers/step-provider 默认值）。
      contextWindow: 256000,
      inputFormat: {
        supportsText: true,
        // 注入的 Step 5 / vision 通道支持图片；旧硬编码 false 会在底座调用前剥离图片。
        supportsImage: true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
      maxOutputTokens: { max: 256000, map: "{}" },
    },
  });
}

/** 注入 provider 的完整 config 形状（对齐 serializeRegistryProviderConfig 的输出字段）。 */
export function createStepCommunityProviderConfig(modelId: string = STEP_COMMUNITY_MODEL_ID) {
  return Object.freeze({
    // group 只能取官方枚举；标准个人档不进入 zai/bigmodel 家族过滤，展示语义最中性。
    group: "standard-personal",
    // access 仅声明连接类型。sparse view schema 的 apiKey 是可选字段：真实 key 只经
    // env/auth.json 被 bridge/CLI 消费，view 里携带任何 key 形态（含占位符）都是多余的泄漏面。
    access: { type: "api-key" } as const,
    api: { type: "openai-chat-completions", baseUrl: STEP_COMMUNITY_API_BASE_URL } as const,
    builtinModelIds: Object.freeze([modelId]),
    visibility: "visible",
  });
}

/**
 * 注入 step provider 的标准模型选择候选投影（纯内存对象，供运行时包装层消费）。
 * modelId 缺省为 STEP_COMMUNITY_MODEL_ID；/models 探测切换默认模型时由运行时传入新值，
 * 保持 view 模型清单与 preferredSelection 一致（否则渲染端会出现 model-not-found 假象）。
 */
export function createStepCommunityProviderView(modelId: string = STEP_COMMUNITY_MODEL_ID, mode?: "api" | "subscription"): ModelSelectionProviderView {
  return Object.freeze({
    providerId: mode === "api" ? STEP_API_PROVIDER_ID : mode === "subscription" ? STEP_PLAN_PROVIDER_ID : STEP_COMMUNITY_PROVIDER_ID,
    providerName: mode === "api" ? "阶跃星辰 API" : mode === "subscription" ? "Step Plan 订阅" : STEP_COMMUNITY_PROVIDER_NAME,
    templateId: STEP_COMMUNITY_PROVIDER_TEMPLATE_ID,
    config: mode ? { ...createStepCommunityProviderConfig(modelId), api: { type: "openai-chat-completions" as const, baseUrl: mode === "api" ? STEP_COMMUNITY_API_BASE_URL : "https://api.stepfun.com/step_plan/v1" } } : createStepCommunityProviderConfig(modelId),
    models: Object.freeze([
      Object.freeze({
        modelId,
        config: createStepCommunityModelConfig(),
      }),
    ]),
  });
}

export function isStepCommunitySelection(selection: ModelSelection | null | undefined): boolean {
  return [STEP_COMMUNITY_PROVIDER_ID, STEP_API_PROVIDER_ID, STEP_PLAN_PROVIDER_ID].includes(selection?.providerId ?? "");
}

type StepCommunitySelectionIssue =
  | "model-not-found"
  | "reasoning-level-missing"
  | "reasoning-level-not-supported";

/**
 * 对指向注入 provider 的选择意图做本地解析（镜像 resolveEffectiveModelSelection 的关键语义：
 * provider/model 必须存在；reasoning 档位合法才视为完整，否则附带 selectionIssue 但仍保留
 * effectiveSelection 主体）。非 step 选择由基线投影处理，上游语义零改动。
 * expectedModelId 缺省为 STEP_COMMUNITY_MODEL_ID；/models 探测切换默认模型后由运行时传入新值。
 */
export function resolveStepCommunityEffectiveSelection(
  selection: ModelSelection,
  expectedModelId: string = STEP_COMMUNITY_MODEL_ID,
): {
  effectiveSelection: ModelSelection;
  selectionIssue?: StepCommunitySelectionIssue;
} {
  if (selection.modelId !== expectedModelId) {
    return { effectiveSelection: selection, selectionIssue: "model-not-found" };
  }
  const reasoningLevel = selection.options?.reasoningLevel;
  if (reasoningLevel === undefined) {
    return { effectiveSelection: selection, selectionIssue: "reasoning-level-missing" };
  }
  if (reasoningLevel !== "disabled" && reasoningLevel !== "enabled") {
    return { effectiveSelection: selection, selectionIssue: "reasoning-level-not-supported" };
  }
  return { effectiveSelection: selection };
}

/** 校验并保存阶跃星辰 API Key 的结果（renderer 优先原样展示 message，仅缺失时按 code 落 i18n 兜底）。 */
export type StepCommunityApiKeyValidationOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "invalid" | "network";
      /**
       * 完整中文错误句（含真实失败原因，如本地凭据文件损坏路径）。
       * 展示约定：renderer 优先原样展示本字段——code 只是粗分类（本地写盘故障也归 network），
       * 按 code 映射文案会把本地故障误报成网络故障，误导排查方向。
       */
      readonly message: string;
    };

export interface StepCommunityStatus {
  readonly displayName?: string;
  readonly connectionMode?: "api" | "subscription";
  readonly configuredKeyTails?: { api?: string; subscription?: string };
  /** 社区模式是否生效（STEP_BACKEND=stepcode-local）；与 key 是否可用无关。 */
  readonly active: boolean;
  readonly keySource: "env" | "file" | "none";
  /**
   * 已连接 key 的尾 4 位掩码（host 侧派生，renderer 唯一可见的 key 信息）。
   * 仅社区模式且 key 存在时携带；完整 key 绝不越过本接口（日志纪律同 stepCommunityApiKey）。
   */
  readonly apiKeyTail?: string;
}

/**
 * 阶跃星辰账户余额投影（docs/step-account-balance-spec.md 的 host 服务层契约，字段不得增删）。
 *
 * host 侧 `getAccountBalance` 是唯一事实源，renderer 只投影：不缓存、不派生、不换算、不落盘。
 * status 语义：
 * - `ok`：请求成功且响应体合法；金额字段缺省表示上游没给（或值非法被 host 舍弃），UI 走 empty 占位。
 * - `no-key`：没有可用 key（readStepApiKey().source === "none"），host 未发请求。
 * - `unsupported`：连接模式是 subscription（Step Plan 独立 Credit 月池，官方无该维度查询接口）。
 * - `invalid`：key 失效（401/403）。
 * - `network`：其余非 2xx、fetch 抛错 / 超时、或响应体非法。
 *
 * 金额字段在 host 侧已校验 `Number.isFinite` 且 `>= 0` 才下发，renderer 不得再做兜底加工；
 * 余额本身为 0 时如实渲染 `0.00`，不隐藏、不报错、不用 0 冒充缺失。
 */
export interface StepCommunityBalance {
  readonly status: "ok" | "no-key" | "unsupported" | "network" | "invalid";
  readonly balance?: number;
  readonly accountType?: "prepaid" | "postpaid";
  readonly totalCashBalance?: number;
  readonly totalVoucherBalance?: number;
  /** HTTP 状态码；未发请求（no-key/unsupported）或 fetch 抛错/超时时为 null。仅诊断用。 */
  readonly httpStatus?: number | null;
  /** 网络类错误的异常名（只记 name，不记可能携带 URL 的 message）。 */
  readonly errorName?: string;
}

export interface IStepCommunityService {
  setDisplayName(input: { readonly displayName: string }): Promise<{ displayName: string }>;
  /** 校验 key（GET api.stepfun.com/v1/models）→ 通过后写入 CLI 的 auth.json 并激活注入。 */
  validateAndStoreApiKey(input: {
    readonly apiKey: string;
    readonly connectionMode?: "api" | "subscription";
    readonly useSaved?: boolean;
  }): Promise<StepCommunityApiKeyValidationOutcome>;
  /** UI 分支判定：active=false 时表单走原 createPersonalProvider 路径。 */
  getStatus(): Promise<StepCommunityStatus>;
  /**
   * 拉取阶跃星辰账户余额（GET https://api.stepfun.com/v1/accounts，只读投影）。
   * 只对 connectionMode === "api" 的已配置 key 发请求；
   * subscription → status="unsupported"，无可用 key → status="no-key"（均不发请求）。
   */
  getAccountBalance(): Promise<StepCommunityBalance>;
}

export const IStepCommunityService = createServiceDescriptor<IStepCommunityService>(
  ServiceChannels.StepCommunity,
);
