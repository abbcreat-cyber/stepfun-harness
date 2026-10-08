import { EyeIcon, EyeOffIcon } from "lucide-react";
import { TID_MODEL_PROVIDER_API_KEY_INPUT } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";

export function ApiKeyInput({
  value,
  visible,
  readOnly,
  placeholderId,
  testId = TID_MODEL_PROVIDER_API_KEY_INPUT,
  label,
  onChange,
  onBlur,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onToggleVisibility,
}: {
  value: string;
  visible: boolean;
  readOnly?: boolean;
  /** 可选 placeholder 的 i18n key；缺省用上游「输入 API Key」。 */
  placeholderId?: string;
  /** 可选 testid 覆盖（社区卡等场景）；缺省用上游 model-provider-api-key-input。 */
  testId?: string;
  label?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  onToggleVisibility: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="relative">
      <Input
        {...TECHNICAL_INPUT_ATTRIBUTES}
        type={visible && !readOnly ? "text" : "password"}
        size="lg"
        data-testid={testId}
        aria-label={label}
        className="pr-10 h-9"
        placeholder={intl.formatMessage({
          id: placeholderId ?? "settings.modelProvider.apiKeyPlaceholder",
        })}
        value={value}
        readOnly={readOnly}
        disabled={readOnly}
        onChange={(event) => {
          if (!readOnly) {
            onChange(event.target.value);
          }
        }}
        onBlur={readOnly ? undefined : onBlur}
        onKeyDown={readOnly ? undefined : onKeyDown}
        onCompositionStart={readOnly ? undefined : onCompositionStart}
        onCompositionEnd={readOnly ? undefined : onCompositionEnd}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={readOnly}
        className="absolute top-1/2 right-1.5 -translate-y-1/2"
        onClick={onToggleVisibility}
      >
        {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
