import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/index.js";

export type StepFirstUseSource = "subscription" | "api" | "custom";
export type StepFirstUseDraft = { name: string; endpoint: string; model: string; apiType: "openai-chat-completions" | "anthropic-messages"; key: string };

export function StepFirstUseFields({ source, draft, onChange, pending, visible, onToggleVisibility }: {
  source: StepFirstUseSource;
  draft: StepFirstUseDraft;
  onChange: (patch: Partial<StepFirstUseDraft>) => void;
  pending: boolean;
  visible: boolean;
  onToggleVisibility: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `step.firstUse.${key}` });
  return (
    <div className="step-first-use-fields">
      {source === "custom" ? <>
        <div className="step-first-use-field-pair">
          <label className="step-first-use-field text-ui-caption">{t("providerName")}<Input autoComplete="off" value={draft.name} disabled={pending} placeholder={t("providerNamePlaceholder")} onChange={e => onChange({ name: e.target.value })} data-testid="step-welcome-provider-name" /></label>
          <label className="step-first-use-field text-ui-caption">{t("protocol")}<Select value={draft.apiType} disabled={pending} onValueChange={v => onChange({ apiType: v as StepFirstUseDraft["apiType"] })}><SelectTrigger aria-label={t("protocol")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai-chat-completions">OpenAI</SelectItem><SelectItem value="anthropic-messages">Anthropic</SelectItem></SelectContent></Select></label>
        </div>
        <div className="step-first-use-field-pair step-first-use-endpoint-pair">
          <label className="step-first-use-field text-ui-caption">{t("endpoint")}<Input autoComplete="off" spellCheck={false} className="font-mono" value={draft.endpoint} disabled={pending} placeholder="https://api.example.com/v1" onChange={e => onChange({ endpoint: e.target.value })} data-testid="step-welcome-endpoint" /></label>
          <label className="step-first-use-field text-ui-caption">{t("modelId")}<Input autoComplete="off" spellCheck={false} className="font-mono" value={draft.model} disabled={pending} placeholder={t("modelPlaceholder")} onChange={e => onChange({ model: e.target.value })} data-testid="step-welcome-model-id" /></label>
        </div>
      </> : null}
      <label className="step-first-use-field text-ui-caption">
        {t(source === "subscription" ? "planKey" : "apiKey")}
        <div className="relative">
          <Input type={visible ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={draft.key} disabled={pending} placeholder={t("keyPlaceholder")} className="pr-10 font-mono" onChange={e => onChange({ key: e.target.value })} data-testid="step-welcome-key" />
          <Button type="button" variant="ghost" size="icon-sm" className="absolute top-1/2 right-1 -translate-y-1/2" disabled={pending} aria-label={t(visible ? "hideKey" : "showKey")} onClick={onToggleVisibility}>{visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
        </div>
      </label>
    </div>
  );
}
