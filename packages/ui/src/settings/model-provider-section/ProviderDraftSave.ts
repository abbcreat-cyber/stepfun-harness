import {
  DEFAULT_CUSTOM_PROVIDER_API_TYPE,
  isApiKeyAccess,
  type ProviderApiType,
} from "@zcode/provider";
import {
  configuredJsonDraft,
  parseProviderAdvancedDraft,
  type ProviderAdvancedDraftValues,
} from "./ProviderAdvancedDraft.js";
import {
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";

export interface ProviderDraftValues extends Partial<ProviderAdvancedDraftValues> {
  nameValue: string;
  apiFormat: ProviderApiType;
  baseUrlValue: string;
  apiKeyValue: string;
}

function normalizeConfiguredBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return "";

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return normalized;
    const marker = `${parsed.protocol}//${parsed.host}`;
    const duplicateIndex = normalized.indexOf(marker, marker.length);
    if (duplicateIndex < 0) return normalized;
    const firstUrl = normalized.slice(0, duplicateIndex).replace(/\/+$/, "");
    const secondUrl = normalized.slice(duplicateIndex).replace(/\/+$/, "");
    // 旧设置页曾把完整 Base URL 再作为 path 拼接；仅折叠两段完全相同的安全形态。
    return firstUrl === secondUrl ? firstUrl : normalized;
  } catch {
    return normalized;
  }
}

export function resolvePendingProviderDraftSave({
  provider,
  draft,
  readOnlyEndpoints,
  nameConfirmed = false,
}: {
  provider: ProviderSettingsFormProvider;
  draft: ProviderDraftValues;
  readOnlyEndpoints?: boolean;
  nameConfirmed?: boolean;
  now: () => number;
}): ProviderSettingsFormProvider | null {
  const label = draft.nameValue.trim();
  const baseURL = normalizeConfiguredBaseUrl(draft.baseUrlValue);
  // ID 和默认协议只用于空配置的表单展示，不是用户覆盖；脏检查与表单初始化必须同源。
  // 名称只在 Enter/失焦确认；连接的闲时保存、测试和卸载不能夹带未确认的名称。
  const labelChanged = nameConfirmed && label !== getProviderFormLabel(provider);
  const typeChanged =
    !readOnlyEndpoints &&
    draft.apiFormat !== (provider.config.api?.type ?? DEFAULT_CUSTOM_PROVIDER_API_TYPE);
  const urlChanged = !readOnlyEndpoints && baseURL !== (provider.config.api?.baseUrl ?? "");
  const keyChanged =
    isApiKeyAccess(provider.config.access) &&
    draft.apiKeyValue !== (provider.config.access.apiKey ?? "");
  const headersChanged =
    !readOnlyEndpoints &&
    draft.headersValue !== undefined &&
    draft.headersValue !== configuredJsonDraft(provider.personalConfig.api?.headers);
  const compatChanged =
    !readOnlyEndpoints &&
    draft.compatValue !== undefined &&
    draft.compatValue !== configuredJsonDraft(provider.personalConfig.api?.compat);
  const authChanged =
    !readOnlyEndpoints &&
    provider.config.access?.type === "api-key" &&
    draft.authModeValue !== undefined &&
    draft.authModeValue !== (provider.config.api?.authMode ?? "api-key");
  const apiChanged = typeChanged || urlChanged || headersChanged || compatChanged || authChanged;
  if (!labelChanged && !apiChanged && !keyChanged) return null;
  const advanced = parseProviderAdvancedDraft(draft, draft.apiFormat);
  if ((headersChanged && advanced.headers.error) || (compatChanged && advanced.compat.error))
    throw new Error(
      advanced.headers.error ?? advanced.compat.error ?? "Invalid connection configuration",
    );

  // 表单只更新用户编辑的连接叶子；重建整个 api 会删除未触碰的原生设置，
  // 保存 Effective 对象又会把继承字段物化。分别在各自基线上只应用修改过的叶子。
  const apiChanges = {
    ...(typeChanged || (apiChanged && !provider.config.api?.type) ? { type: draft.apiFormat } : {}),
    ...(urlChanged ? { baseUrl: baseURL || undefined } : {}),
    ...(headersChanged ? { headers: advanced.headers.value } : {}),
    ...(compatChanged ? { compat: advanced.compat.value } : {}),
    ...(authChanged ? { authMode: draft.authModeValue } : {}),
  };
  const api = apiChanged ? { ...provider.config.api, ...apiChanges } : provider.config.api;
  const access =
    keyChanged && isApiKeyAccess(provider.config.access)
      ? { ...provider.config.access, apiKey: draft.apiKeyValue }
      : provider.config.access;
  const config = {
    ...provider.config,
    access,
    api,
  };

  const personalConfig = {
    ...provider.personalConfig,
    ...(keyChanged && isApiKeyAccess(provider.config.access)
      ? {
          access: {
            ...provider.personalConfig.access,
            type: provider.config.access.type,
            apiKey: draft.apiKeyValue,
          },
        }
      : {}),
    ...(apiChanged ? { api: { ...provider.personalConfig.api, ...apiChanges } } : {}),
  };

  if (
    !labelChanged &&
    JSON.stringify(config) === JSON.stringify(provider.config) &&
    JSON.stringify(personalConfig) === JSON.stringify(provider.personalConfig)
  ) {
    return null;
  }
  return {
    ...provider,
    ...(labelChanged ? { providerName: label || null, providerNameUpdate: label || null } : {}),
    config,
    personalConfig,
  };
}
