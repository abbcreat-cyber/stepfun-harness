/*
 * Desktop Registry → Step 原生 models.json 的完整配置投影。
 * Derives from zai-org/ZCode, Apache-2.0; community-maintained integration.
 * 凭据只在内存流水线流向 CLI 私有配置文件，日志与错误不输出配置对象或 key。
 */
import { resolveStepConfigPaths } from "@zcode/shared/node";
import {
  serializeRegistryModelConfig,
  serializeRegistryProviderConfig,
  type ProviderRegistryServiceSnapshot,
} from "@zcode/provider";
import { reconcileStepCliModelsFile } from "./cliProviderModelsFile.js";
import { isStepCommunitySelection, type StepEnvRecord } from "./stepCommunityModelSelection.js";
export {
  createStepCliProviderSyncSink,
  type StepCliProviderSyncSink,
} from "./cliProviderSyncSink.js";

interface NativeModelConfig {
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly compat?: Readonly<Record<string, unknown>> | null;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>> | null;
  readonly samplingParams?: Readonly<Record<string, unknown>> | null;
  readonly reasoning?: boolean | null;
}

/** 只消费已提交 Registry 的序列化形状，不依赖领域行为类。 */
export interface StepCliRegistryProviderViewLike {
  readonly providerId: string;
  readonly config: {
    readonly access?: { readonly type?: string; readonly apiKey?: string | null } | null;
    readonly api?: {
      readonly type?: string;
      readonly baseUrl?: string | null;
      readonly headers?: Readonly<Record<string, string>> | null;
      readonly authMode?: "api-key" | "headers" | "none" | null;
      readonly compat?: Readonly<Record<string, unknown>> | null;
    } | null;
  };
  readonly models: readonly {
    readonly modelId: string;
    readonly config?: {
      readonly properties?: {
        readonly contextWindow?: number | null;
        readonly supportsToolCall?: boolean | null;
        readonly inputFormat?: { readonly supportsImage?: boolean | null } | null;
      } | null;
      readonly optionSpecs?: {
        readonly reasoningLevel?: {
          readonly values?: readonly string[] | null;
          readonly map?: string | null;
        } | null;
        readonly maxOutputTokens?: {
          readonly max?: number | null;
          readonly map?: string | null;
        } | null;
      } | null;
      readonly native?: NativeModelConfig | null;
    } | null;
  }[];
}

export type StepCliCustomProviderApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses";
export interface StepCliCustomProviderModelEntry {
  readonly modelId: string;
  readonly supportsImage: boolean;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: Readonly<Record<string, unknown>>;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly samplingParams?: Readonly<Record<string, unknown>>;
}
export interface StepCliCustomProviderEntry {
  readonly providerId: string;
  readonly api: StepCliCustomProviderApi;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly authHeader?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: Readonly<Record<string, unknown>>;
  readonly models: readonly StepCliCustomProviderModelEntry[];
}
export type StepCliProviderSyncSkipReason =
  | "not-in-registry-view"
  | "unsupported-access-type"
  | "missing-api-key"
  | "unsupported-api-type"
  | "invalid-base-url"
  | "no-models";
export interface StepCliProviderSyncPlan {
  readonly providers: readonly StepCliCustomProviderEntry[];
  readonly skipped: readonly {
    readonly providerId: string;
    readonly reason: StepCliProviderSyncSkipReason;
  }[];
}

const API_TYPES: Readonly<Record<string, StepCliCustomProviderApi>> = {
  "anthropic-messages": "anthropic-messages",
  "openai-chat-completions": "openai-completions",
  "openai-responses": "openai-responses",
};
const INTERNAL_AUTH_GATE = "__stepcode_internal_auth_gate__";

export function resolveStepModelsFilePath(
  env: StepEnvRecord,
  opts?: { readonly modelsFilePath?: string },
): string {
  return opts?.modelsFilePath || resolveStepConfigPaths(env).modelsFile;
}

/** 桌面执行只认当前完整 Registry 或官方连接事实；手写 CLI 项不能充当桌面资格。 */
export function assertStepCliModelExecutionAvailable(
  selection: { readonly providerId: string; readonly modelId: string },
  registryProviders: readonly {
    readonly providerId: string;
    readonly models: readonly { readonly modelId: string }[];
  }[],
  stepProviders: readonly {
    readonly providerId: string;
    readonly models: readonly { readonly modelId: string }[];
  }[] = [],
): void {
  const providers = isStepCommunitySelection(selection) ? stepProviders : registryProviders;
  if (
    providers.some(
      (provider) =>
        provider.providerId === selection.providerId &&
        provider.models.some((model) => model.modelId === selection.modelId),
    )
  )
    return;
  throw Object.assign(
    new Error(
      `无法执行模型 ${selection.providerId}/${selection.modelId}：当前桌面配置中已删除、禁用或不可执行，请选择有效模型后重试`,
    ),
    { code: "model_selection_unavailable" },
  );
}

function projectModel(
  model: StepCliRegistryProviderViewLike["models"][number],
): StepCliCustomProviderModelEntry {
  const config = model.config;
  const native = config?.native;
  const levels = config?.optionSpecs?.reasoningLevel?.values ?? [];
  // 只有原生已知档位或显式覆盖是 reasoning 依据；任意 DSL/名字不能推断能力。
  const reasoning =
    native?.reasoning ??
    (levels.some((level) => ["minimal", "low", "medium", "high", "xhigh", "max"].includes(level))
      ? true
      : levels.length > 0 && levels.every((level) => ["off", "disabled"].includes(level))
        ? false
        : undefined);
  return {
    modelId: model.modelId.trim(),
    supportsImage: config?.properties?.inputFormat?.supportsImage === true,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(config?.properties?.contextWindow != null
      ? { contextWindow: config.properties.contextWindow }
      : {}),
    ...(config?.optionSpecs?.maxOutputTokens?.max != null
      ? { maxTokens: config.optionSpecs.maxOutputTokens.max }
      : {}),
    ...(native?.headers != null ? { headers: native.headers } : {}),
    ...(native?.compat != null ? { compat: native.compat } : {}),
    ...(native?.thinkingLevelMap != null ? { thinkingLevelMap: native.thinkingLevelMap } : {}),
    ...(native?.samplingParams != null ? { samplingParams: native.samplingParams } : {}),
  };
}

/** ids 和 providers 必须来自同一 RegistryServiceSnapshot；空计划也进入 writer。 */
export function buildCliSyncProviders(
  personalProviderIds: Iterable<string>,
  registryProviders: readonly StepCliRegistryProviderViewLike[],
): StepCliProviderSyncPlan {
  const providers: StepCliCustomProviderEntry[] = [];
  const skipped: { providerId: string; reason: StepCliProviderSyncSkipReason }[] = [];
  const views = new Map(registryProviders.map((provider) => [provider.providerId, provider]));
  for (const id of new Set(personalProviderIds)) {
    const providerId = id.trim();
    if (!providerId) continue;
    const view = views.get(providerId);
    let reason: StepCliProviderSyncSkipReason | undefined;
    const authMode = view?.config.api?.authMode ?? "api-key";
    const apiKey =
      authMode === "api-key" ? (view?.config.access?.apiKey?.trim() ?? "") : INTERNAL_AUTH_GATE;
    const api = API_TYPES[view?.config.api?.type ?? ""];
    const baseUrl = view?.config.api?.baseUrl?.trim() ?? "";
    if (!view) reason = "not-in-registry-view";
    else if (view.config.access?.type !== "api-key") reason = "unsupported-access-type";
    else if (!apiKey) reason = "missing-api-key";
    else if (!api) reason = "unsupported-api-type";
    else {
      try {
        if (!["http:", "https:"].includes(new URL(baseUrl).protocol)) reason = "invalid-base-url";
      } catch {
        reason = "invalid-base-url";
      }
    }
    if (reason) {
      skipped.push({ providerId, reason });
      continue;
    }
    const seen = new Set<string>();
    const models = (view?.models ?? [])
      .filter((model) => {
        const modelId = model.modelId?.trim();
        if (!modelId || seen.has(modelId)) return false;
        seen.add(modelId);
        return true;
      })
      .map((model) => {
        const projected = projectModel(model);
        // SDK 启动快照携带扩展契约；不重复凭据/headers，也不读取运行中 live 配置。
        const needsHooks =
          view?.config.api?.authMode != null ||
          model.config?.native?.samplingParams != null ||
          model.config?.optionSpecs != null ||
          model.config?.properties?.supportsToolCall != null;
        return !needsHooks
          ? projected
          : {
              ...projected,
              compat: {
                ...projected.compat,
                stepcodeDesktop: {
                  version: 1,
                  providerId,
                  modelId: projected.modelId,
                  protocol: api,
                  apiRoot: baseUrl,
                  authMode,
                  ...(model.config?.properties?.supportsToolCall != null
                    ? { supportsToolCall: model.config.properties.supportsToolCall }
                    : {}),
                  ...(model.config?.optionSpecs != null
                    ? { optionSpecs: model.config.optionSpecs }
                    : {}),
                },
              },
            };
      });
    if (!models.length) {
      skipped.push({ providerId, reason: "no-models" });
      continue;
    }
    providers.push({
      providerId,
      api: api!,
      baseUrl,
      apiKey,
      ...(authMode !== "api-key" ? { authHeader: false } : {}),
      models,
      ...(view?.config.api?.headers != null ? { headers: view.config.api.headers } : {}),
      ...(view?.config.api?.compat != null ? { compat: view.config.api.compat } : {}),
    });
  }
  return { providers, skipped };
}

/** 生产投影入口强制个人 id 与有效模型来自同一已提交 snapshot。 */
export function buildCliSyncProvidersFromSnapshot(snapshot: {
  readonly config: Pick<ProviderRegistryServiceSnapshot["config"], "personalProviders">;
  readonly registry: ProviderRegistryServiceSnapshot["registry"];
}): StepCliProviderSyncPlan {
  return buildCliSyncProviders(
    snapshot.config.personalProviders.keys(),
    snapshot.registry.providers.map((provider) => ({
      providerId: provider.providerId,
      config: serializeRegistryProviderConfig(provider.config),
      models: provider.models.map((model) => ({
        modelId: model.modelId,
        config: serializeRegistryModelConfig(model.config),
      })),
    })),
  );
}

export async function syncCustomProvidersToStepCliModelsFile(
  env: StepEnvRecord,
  providers: readonly StepCliCustomProviderEntry[],
  opts?: { readonly modelsFilePath?: string },
): Promise<{ readonly modelsFilePath: string; readonly syncedProviderIds: readonly string[] }> {
  const modelsFilePath = resolveStepModelsFilePath(env, opts);
  const desired = new Map<string, unknown>();
  for (const provider of providers) {
    if (desired.has(provider.providerId))
      throw new Error(`Step CLI 待同步供应商重复（${provider.providerId}）`);
    const { providerId, models, ...connection } = provider;
    desired.set(providerId, {
      ...connection,
      models: models.map((model) => {
        const { modelId, supportsImage, ...options } = model;
        return {
          id: modelId,
          input: supportsImage ? ["text", "image"] : ["text"],
          ...options,
          // 最基础的 API Key 模型同样走统一扩展（例如原生 Anthropic CRLF 边界）。
          compat: {
            ...model.compat,
            stepcodeDesktop: model.compat?.stepcodeDesktop ?? {
              version: 1,
              providerId,
              modelId,
              protocol: provider.api,
              apiRoot: provider.baseUrl,
              authMode: "api-key",
            },
          },
        };
      }),
    });
  }
  await reconcileStepCliModelsFile(modelsFilePath, desired);
  return { modelsFilePath, syncedProviderIds: [...desired.keys()].sort() };
}
