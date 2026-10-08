import type { ProviderApiType, ProviderAuthMode } from "@zcode/provider";
import {
  nativeCompatSchemaForApi,
  nativeHeadersDataSchema,
  nativeModelConfigDataSchema,
  nativeModelSchemaForApi,
} from "@zcode/shared/model-config";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

export interface ProviderAdvancedDraftValues {
  authModeValue: ProviderAuthMode;
  headersValue: string;
  compatValue: string;
}

export function configuredJsonDraft(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

export function createProviderAdvancedDraftValues(
  provider: ProviderSettingsFormProvider,
): ProviderAdvancedDraftValues {
  return {
    authModeValue: provider.config.api?.authMode ?? "api-key",
    headersValue: configuredJsonDraft(provider.personalConfig.api?.headers),
    compatValue: configuredJsonDraft(provider.personalConfig.api?.compat),
  };
}

export function parseProviderAdvancedDraft(
  draft: Partial<ProviderAdvancedDraftValues>,
  apiType: ProviderApiType,
) {
  const headers = parseJsonField(draft.headersValue, nativeHeadersDataSchema.nullable());
  const compat = parseJsonField(draft.compatValue, nativeCompatSchemaForApi(apiType).nullable());
  return { headers, compat };
}

export function parseNativeModelDraft(source: string | undefined, apiType?: string) {
  return parseJsonField(
    source,
    (apiType ? nativeModelSchemaForApi(apiType) : nativeModelConfigDataSchema).nullable(),
  );
}

function parseJsonField<T>(source: string | undefined, schema: { parse(input: unknown): T }) {
  if (!source?.trim()) return { value: undefined, error: null };
  try {
    return { value: schema.parse(JSON.parse(source)), error: null };
  } catch (error) {
    const issues =
      error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
        ? error.issues
        : undefined;
    return {
      value: undefined,
      error: issues
        ? issues
            .map(
              (issue: { path: (string | number)[]; message: string }) =>
                `${issue.path.join(".") || "JSON"}: ${issue.message}`,
            )
            .join("\n")
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}
