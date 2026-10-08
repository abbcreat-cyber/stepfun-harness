/*
 * Step-Code (community) 模型选择注入层的运行时实现（host-only，依赖 node:fs/fetch）。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 * Community-maintained integration; not affiliated with or endorsed by Z.ai.
 *
 * 包装语义（纯加法）：
 * - STEP_BACKEND=stepcode-local 未命中 → 原样返回 base service 引用（零包装）。
 * - revision 单调递增：renderer useModelSelectionServiceView 会丢弃 revision 更小的候选视图，
 *   包装层用 max(基线 revision, 状态翻转 floor) 投影，保证 bump 后必被接受。
 */
import type { ModelSelectionView, ModelSelectionViewInput } from "@zcode/provider";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { IModelSelectionService } from "./providerFacadeServices.js";
import {
  STEP_API_KEY_ENV,
  STEP_COMMUNITY_DEFAULT_SELECTION,
  STEP_COMMUNITY_MODEL_ID,
  STEP_COMMUNITY_PROVIDER_ID,
  STEP_API_PROVIDER_ID,
  STEP_PLAN_PROVIDER_ID,
  createStepCommunityProviderView,
  isStepCommunityBackendActive,
  isStepCommunitySelection,
  resolveStepCommunityEffectiveSelection,
  type StepCommunityBalance,
  type StepCommunityStatus,
  type StepEnvRecord,
  type IStepCommunityService,
} from "./stepCommunityModelSelection.js";
import {
  fetchStepAccountBalance,
  readStepApiKey,
  readStepConnectionKey,
  validateStepApiKey,
  writeStepDesktopCredential,
  readStepDesktopCredentials,
  readStepDisplayName,
  writeStepDisplayName,
  type StepApiKeyValidationResult,
} from "./stepCommunityApiKey.js";

const logger = createServiceLogger("step-community");

/**
 * 已知该平台真实可聊的候选模型（按优先级降序；首位即注入默认）。
 * 证据状态（诚实声明）：本清单来自开发过程中的对话级手工验证，验证脚本未存档、
 * 本仓库内无可复核记录；「真实可聊」的结论目前无从对证，只当优先级启发使用。
 * 机制上这是 /models 清单级的第一层探测——在列 ≠ 套餐一定能聊：若首位在列但套餐
 * 不可聊，probe 不会切换，最终由 bridge 发送侧的诚实中文报错兜底
 * （classifyStepSendError 兜底文案已同时点名网络/API Key/套餐三个排查方向）。
 */
const KNOWN_CHATABLE_STEP_MODEL_IDS: readonly string[] = [STEP_COMMUNITY_MODEL_ID, "step-1o-turbo-vision"];

/**
 * /models 在列清单 ∩ 已知可用清单 → 第一个交集成员；探测缺失（modelIds undefined）
 * 或交集为空 → null（调用方维持默认并中文告警）。
 */
function pickPreferredStepModelId(modelIds: readonly string[] | undefined): string | null {
  if (!modelIds || modelIds.length === 0) return null;
  const listed = new Set(modelIds);
  return KNOWN_CHATABLE_STEP_MODEL_IDS.find((id) => listed.has(id)) ?? null;
}

export interface StepAwareModelSelectionService extends IModelSelectionService {
  /** 当前是否处于注入态。 */
  readonly isInjectionActive: boolean;
  /**
   * 显式覆盖注入态（表单写入 key 成功后强制 true；后台复核 401/403 后 false）。
   * 状态翻转时 bump onDidChange；幂等，重复同值调用不产生额外事件。
   */
  setInjectionActive(active: boolean, reason: string): void;
  /**
   * /models 探测命中已知可用清单时切换注入默认模型（view 模型清单与 preferredSelection 同步）。
   * 幂等，值不变不产生事件；切换时 bump onDidChange。
   */
  updatePreferredCommunityModel(modelId: string, reason: string, mode?: "api" | "subscription"): void;
  refreshConnections(): void;
  /** 供 IStepCommunityService 的 keySource 读取（env 优先，file 兜底）。 */
  resolveCurrentKeySource(): "env" | "file" | "none";
  /** 后台复核当前注入 key（乐观注入的两级语义第二级）。幂等，进程内只跑一轮。 */
  startBackgroundKeyValidationOnce(): void;
  dispose(): void;
}

/**
 * STEP_BACKEND=stepcode-local 且有可用 key 时返回注入包装；否则原样返回 base 引用。
 * 调用方（node.ts）只用返回值替换三处模型执行就绪相关引用，其余官方引用一律保持 base。
 */
export function wrapModelSelectionServiceForStepCommunity(
  base: IModelSelectionService,
  options: { env: StepEnvRecord },
): IModelSelectionService {
  if (!isStepCommunityBackendActive(options.env)) {
    return base;
  }

  const initialKeySource = readStepApiKey(options.env);
  let injectionActive = Boolean(readStepConnectionKey(options.env, "api").key || readStepConnectionKey(options.env, "subscription").key);
  if (injectionActive) {
    logger.info(undefined, "Step community model selection injection enabled (optimistic)", {
      keySource: initialKeySource.source,
      providerId: STEP_COMMUNITY_PROVIDER_ID,
      modelId: STEP_COMMUNITY_MODEL_ID,
    });
  }

  const listeners = new Set<(view: ModelSelectionView) => void>();
  let disposed = false;
  let lastProjectedRevision = 0;
  let revisionFloor = 0;
  let backgroundValidationStarted = false;
  /** 当前注入默认模型（/models 探测命中已知可用清单的更靠前成员时切换；初始为既有默认）。 */
  let preferredCommunityModelId: string = STEP_COMMUNITY_DEFAULT_SELECTION.modelId;
  const preferredModels = { api: preferredCommunityModelId, subscription: preferredCommunityModelId };
  const invalidModes = new Set<"api" | "subscription">();

  // 单调 revision：投影 revision 只增不减；状态翻转时抬高 floor，保证下一次投影必大于历史值。
  const nextRevision = (baseRevision: number): number => {
    lastProjectedRevision = Math.max(baseRevision, lastProjectedRevision, revisionFloor);
    return lastProjectedRevision;
  };

  const projectView = (baseView: ModelSelectionView): ModelSelectionView => {
    if (!injectionActive) {
      // 撤注入态的透传也要 ratchet revision：两次状态翻转（注入→撤除→再注入）之间基线 revision
      // 可能不变，直接透传会让再注入的 bump 与撤除前视图同号；renderer 只拒绝更小 revision，
      // 同号虽可被接受，但严格单调能保证任何一次 bump 都必然替换上一份已提交视图。
      return Object.freeze({ ...baseView, revision: nextRevision(baseView.revision) });
    }
    const modes = (["api", "subscription"] as const).filter(mode =>
      readStepConnectionKey(options.env, mode).key && !invalidModes.has(mode));
    if (!modes.length) return Object.freeze({ ...baseView, revision: nextRevision(baseView.revision) });
    // 保留隐藏的旧 step 身份供历史恢复；新列表按计费通道分成两项，不能借 activeMode 互换。
    const legacy = createStepCommunityProviderView(preferredCommunityModelId);
    const providers = [...baseView.providers.filter(p => ![STEP_COMMUNITY_PROVIDER_ID, STEP_API_PROVIDER_ID, STEP_PLAN_PROVIDER_ID].includes(p.providerId)),
      { ...legacy, config: { ...legacy.config, visibility: "hidden" as const } },
      ...modes.map(mode => createStepCommunityProviderView(preferredModels[mode], mode))];
    const currentMode = readStepApiKey(options.env).connectionMode ?? "api";
    const defaultMode = modes.includes(currentMode) ? currentMode : modes[0]!;
    const preferredSelection = baseView.preferredSelection ?? {
      providerId: defaultMode === "api" ? STEP_API_PROVIDER_ID : STEP_PLAN_PROVIDER_ID,
      modelId: preferredModels[defaultMode],
    };
    return Object.freeze({
      ...baseView,
      revision: nextRevision(baseView.revision),
      providers: Object.freeze(providers),
      preferredSelection,
    });
  };

  const projectViewWithInput = (
    baseView: ModelSelectionView,
    input: ModelSelectionViewInput,
  ): ModelSelectionView => {
    const projected = projectView(baseView);
    if (input.selection === null || !isStepCommunitySelection(input.selection)) {
      return projected;
    }
    // 基线 Registry 没有注入 provider，step 选择在基线投影里必然得到 provider-not-found；
    // 这里按注入 provider 的本地事实重投影 effectiveSelection/selectionIssue。
    if (!projected.providers.some(p => p.providerId === input.selection?.providerId)) return projected;
    const expected = input.selection.providerId === STEP_API_PROVIDER_ID ? preferredModels.api : input.selection.providerId === STEP_PLAN_PROVIDER_ID ? preferredModels.subscription : preferredCommunityModelId;
    const resolved = resolveStepCommunityEffectiveSelection(input.selection, expected);
    return Object.freeze({
      ...projected,
      effectiveSelection: resolved.effectiveSelection,
      selectionIssue: resolved.selectionIssue,
    });
  };

  const getViewInternal = async (): Promise<ModelSelectionView> => {
    const baseView = await base.getView();
    return projectView(baseView);
  };

  const emit = (): void => {
    if (disposed) return;
    void getViewInternal().then(
      (view) => {
        if (disposed) return;
        for (const listener of listeners) listener(view);
      },
      (error: unknown) => {
        if (!disposed) {
          logger.warn(undefined, "Step community model selection view refresh failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
  };

  /**
   * 消费 validateStepApiKey 顺带回传的 /models 清单（第一层探测）：
   * 命中已知可用清单 → 切换注入默认；探测缺失/交集为空 → 维持默认并中文告警
   * （真正套餐不足仍会在发送时被 bridge 的诚实中文报错兜住，不会退化成神秘错误码）。
   */
  const applyModelAvailabilityProbe = (result: StepApiKeyValidationResult, mode?: "api" | "subscription"): void => {
    const picked = pickPreferredStepModelId(result.modelIds);
    if (picked) {
      wrapper.updatePreferredCommunityModel(picked, "models-probe", mode);
      return;
    }
    logger.warn(
      undefined,
      "阶跃星辰模型清单与预期不符，若发送失败请检查阶跃星辰套餐",
      {
        probeAvailable: result.modelIds !== undefined,
        listedCount: result.modelIds?.length ?? 0,
        knownList: [...KNOWN_CHATABLE_STEP_MODEL_IDS],
      },
    );
  };

  const wrapper: StepAwareModelSelectionService = {
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getView: (input?: ModelSelectionViewInput) =>
      base.getView(input).then((baseView) => {
        // 所有读路径（含撤注入态透传）统一过 projectView 的 revision ratchet：
        // renderer 端 latestRevision 只增不减，retraction bump 后任何 revision 更小的视图都会被丢弃。
        // 社区模式关闭时本函数不会被触达（wrap 直接返回 base 引用），上游语义零影响。
        return input ? projectViewWithInput(baseView, input) : projectView(baseView);
      }),
    get isInjectionActive() {
      return injectionActive;
    },
    setInjectionActive(active: boolean, reason: string) {
      if (disposed || active === injectionActive) return;
      injectionActive = active;
      revisionFloor = lastProjectedRevision + 1;
      logger.info(undefined, "Step community model selection injection state changed", {
        active,
        reason,
      });
      emit();
    },
    updatePreferredCommunityModel(modelId: string, reason: string, mode = readStepApiKey(options.env).connectionMode ?? "api") {
      const next = modelId.trim();
      if (disposed || !next || next === preferredModels[mode]) return;
      preferredModels[mode] = next;
      if (mode === (readStepApiKey(options.env).connectionMode ?? "api")) preferredCommunityModelId = next;
      revisionFloor = lastProjectedRevision + 1;
      logger.info(undefined, "Step community default model updated by /models probe", {
        modelId: preferredCommunityModelId,
        reason,
      });
      emit();
    },
    resolveCurrentKeySource: () => readStepApiKey(options.env).source,
    refreshConnections() {
      invalidModes.clear();
      revisionFloor = lastProjectedRevision + 1;
      emit();
    },
    startBackgroundKeyValidationOnce() {
      if (backgroundValidationStarted) return;
      backgroundValidationStarted = true;
      for (const mode of ["api", "subscription"] as const) {
      const keySource = readStepConnectionKey(options.env, mode);
      if (!keySource.key) continue;
      void validateStepApiKey(keySource.key, { connectionMode: mode }).then(
        (result: StepApiKeyValidationResult) => {
          // 仅 401/403 撤注入；网络错误/5xx 保持乐观（断网不锁人）。
          if (result.validity === "invalid") {
            logger.warn(undefined, "Step API key rejected; retracting community injection", {
              httpStatus: result.httpStatus,
              keySource: keySource.source,
              keyLength: keySource.key?.length ?? 0,
            });
            invalidModes.add(mode);
            revisionFloor = lastProjectedRevision + 1;
            emit();
          } else {
            logger.info(undefined, "Step API key background revalidation done", {
              validity: result.validity,
              httpStatus: result.httpStatus,
            });
            applyModelAvailabilityProbe(result, mode);
          }
        },
        (error: unknown) => {
          // validateStepApiKey 内部已把网络异常归一为 network；这里的 reject 分支只可能是实现缺陷。
          logger.error(undefined, "Step API key background revalidation crashed", {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  };

  // 基线变化（官方 Registry 事件）→ 以注入态重投影并转发。
  base.onDidChange(() => emit());
  return wrapper;
}

export function createStepCommunityService(params: {
  readonly env: StepEnvRecord;
  readonly modelSelection: IModelSelectionService;
  readonly connectionsChanged?: () => Promise<void>;
}): IStepCommunityService {
  return {
    setDisplayName: async (input) => ({ displayName: await writeStepDisplayName(params.env, input.displayName) }),
    validateAndStoreApiKey: async (input) => {
      const mode = input.connectionMode === "subscription" ? "subscription" : "api";
      const stored = readStepDesktopCredentials(params.env);
      const apiKey = (input.useSaved ? stored[mode]?.key || (mode === "api" ? params.env.STEP_API_KEY : "") : input.apiKey)?.trim() ?? "";
      if (!apiKey) {
        return { ok: false, code: "invalid", message: "请输入 API Key。" };
      }
      const result = await validateStepApiKey(apiKey, { connectionMode: mode });
      // 日志纪律：只记状态码与 key 长度，绝不记 key 明文。
      logger.info(undefined, "Step community API key validation done", {
        validity: result.validity,
        httpStatus: result.httpStatus,
        keyLength: apiKey.length,
      });
      if (result.validity !== "valid") {
        return result.validity === "invalid"
          ? { ok: false, code: "invalid", message: "API Key 无效，请检查后重新填写。" }
          : {
              ok: false,
              code: "network",
              message: "暂时连不上阶跃星辰（api.stepfun.com），请检查网络后重试。",
            };
      }
      try {
        await writeStepDesktopCredential(params.env, apiKey, mode, { activate: input.useSaved === true });
      } catch (error) {
        logger.error(undefined, "Step community API key write failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          code: "network",
          message: `保存阶跃星辰 API Key 失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      // 表单成功 = 新 key 已验证并落盘：强制激活注入（即使 env 里的旧 key 已失效）并 bump。
      const stepAware = params.modelSelection as StepAwareModelSelectionService;
      stepAware.setInjectionActive?.(true, "api-key-stored");
      stepAware.refreshConnections?.();
      // /models 清单级第一层探测：命中已知可用清单的更靠前成员则切换注入默认。
      const picked = pickPreferredStepModelId(result.modelIds);
      if (picked) stepAware.updatePreferredCommunityModel?.(picked, "models-probe-login", mode);
      else if (result.modelIds !== undefined) {
        logger.warn(
          undefined,
          "阶跃星辰模型清单与预期不符，若发送失败请检查阶跃星辰套餐",
          { listedCount: result.modelIds.length, knownList: [...KNOWN_CHATABLE_STEP_MODEL_IDS] },
        );
      }
      await params.connectionsChanged?.();
      return { ok: true };
    },
    getStatus: async (): Promise<StepCommunityStatus> => {
      const keySource = readStepApiKey(params.env);
      const active = isStepCommunityBackendActive(params.env);
      // 尾 4 位掩码只在社区模式下派生下发；完整 key 绝不进返回值（renderer 唯一可见的 key 信息）。
      return {
        active,
        displayName: await readStepDisplayName(params.env),
        keySource: keySource.source,
        connectionMode: keySource.connectionMode ?? "api",
        configuredKeyTails: {
          api: readStepConnectionKey(params.env, "api").key?.slice(-4),
          subscription: readStepConnectionKey(params.env, "subscription").key?.slice(-4),
        },
        ...(active && keySource.key ? { apiKeyTail: keySource.key.slice(-4) } : {}),
      };
    },
    getAccountBalance: async (): Promise<StepCommunityBalance> => {
      const keySource = readStepConnectionKey(params.env, "api");
      // 余额只属于 API 账户，与当前对话/旧 activeMode 选择无关；不能把订阅 Key 带到此端点。
      if (keySource.source === "none") {
        return { status: "no-key" };
      }
      const balance = await fetchStepAccountBalance(keySource.key ?? "");
      // 日志纪律：只记 status/httpStatus/key 长度，绝不记 key 明文，绝不记余额金额
      // （金额是用户资产数据，只在 renderer 的投影里出现，日志一律不落）。
      logger.info(undefined, "Step community account balance loaded", {
        status: balance.status,
        httpStatus: balance.httpStatus,
        keyLength: keySource.key?.length ?? 0,
      });
      return balance;
    },
  };
}

/** 仅供测试重导出（避免测试硬编码 env 键名漂移）。 */
export const STEP_COMMUNITY_ENV_KEYS = { STEP_API_KEY: STEP_API_KEY_ENV } as const;
