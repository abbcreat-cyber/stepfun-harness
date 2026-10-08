import { useId } from "react";
import type { ProviderApiType, ProviderAuthMode } from "@zcode/provider";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import {
  configuredJsonDraft,
  parseProviderAdvancedDraft,
  type ProviderAdvancedDraftValues,
} from "./ProviderAdvancedDraft.js";

export function ProviderAdvancedSettings({
  provider,
  apiType,
  draft,
  onChange,
  onBlur,
}: {
  provider: ProviderSettingsFormProvider;
  apiType: ProviderApiType;
  draft: ProviderAdvancedDraftValues;
  onChange: (patch: Partial<ProviderAdvancedDraftValues>) => void;
  onBlur: () => void;
}) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const parsed = parseProviderAdvancedDraft(draft, apiType);
  return (
    <details className="space-y-3" data-provider-advanced="true">
      <summary className="w-fit cursor-pointer rounded-sm px-2 py-1 text-ui-base text-foreground hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary">
        {intl.formatMessage({ id: "settings.modelProvider.advancedConfig" })}
      </summary>
      <div className="space-y-3">
        {provider.config.access?.type === "api-key" ? (
          <div>
            <label
              htmlFor={`${id}-auth`}
              className="mb-1 block text-ui-base text-foreground-subtle"
            >
              {intl.formatMessage({ id: "settings.modelProvider.authMode" })}
            </label>
            <Select
              value={draft.authModeValue}
              onValueChange={(value) => onChange({ authModeValue: value as ProviderAuthMode })}
            >
              <SelectTrigger
                id={`${id}-auth`}
                size="lg"
                data-provider-auth-mode="true"
                className="w-full justify-between"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {(["api-key", "headers", "none"] as const).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {intl.formatMessage({ id: `settings.modelProvider.authMode.${mode}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {(["headers", "compat"] as const).map((field) => {
          const error = parsed[field].error;
          return (
            <div key={field} className="space-y-1">
              <label
                htmlFor={`${id}-${field}`}
                className="block text-ui-base text-foreground-subtle"
              >
                {intl.formatMessage({ id: `settings.modelProvider.native.${field}` })}
              </label>
              <Textarea
                {...TECHNICAL_INPUT_ATTRIBUTES}
                id={`${id}-${field}`}
                data-provider-json={field}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${id}-${field}-error` : undefined}
                className="field-sizing-fixed h-28 min-h-28 resize-y font-mono text-ui-base"
                value={draft[`${field}Value`]}
                placeholder={configuredJsonDraft(provider.config.api?.[field]) || "{}"}
                onChange={(event) => onChange({ [`${field}Value`]: event.target.value })}
                onBlur={onBlur}
              />
              {error ? (
                <p
                  id={`${id}-${field}-error`}
                  role="alert"
                  className="whitespace-pre-wrap text-ui-sm text-destructive"
                >
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.native.connectionHelp" })}
        </p>
      </div>
    </details>
  );
}
