import { PanelTop, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

export function StepGettingStartedTip({ onConnect }: { onConnect: () => void }) {
  const { settings, update } = useSettings();
  const { intl } = useZCodeIntl();
  const requestPreferences = useZCodeStore(state => state.setNewUserOnboardingOpen);
  if (!settings?.stepWelcomeCompleted || settings.stepMiniTipDismissed) return null;
  const t = (key: string) => intl.formatMessage({ id: `step.firstUse.${key}` });
  return (
    <aside className="fixed right-5 bottom-5 z-40 w-80 max-w-[calc(100vw-2.5rem)] rounded-2xl border border-border bg-surface-raised p-4 shadow-lg" data-testid="step-first-use-tip" aria-label={t("tipTitle")}>
      <div className="flex items-center gap-2">
        <PanelTop className="size-4 text-icon-blue" />
        <h2 className="flex-1 text-ui-base font-semibold">{t("tipTitle")}</h2>
        <Button variant="ghost" size="icon-sm" aria-label={t("tipDismiss")} onClick={() => void update({ stepMiniTipDismissed: true })}><X className="size-3.5" /></Button>
      </div>
      <p className="mt-2 text-ui-caption leading-relaxed text-foreground-subtle">{t("tipDescription")}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onConnect}>{t("connectModels")}</Button>
        <Button variant="ghost" size="sm" onClick={() => { void update({ stepMiniTipDismissed: true }); requestPreferences(true); }}>{t("preferences")}</Button>
      </div>
    </aside>
  );
}
