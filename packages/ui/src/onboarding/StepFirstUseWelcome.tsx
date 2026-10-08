import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Braces, Check, CheckCircle2, Files, Layers3, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { StepCommunitySparkLogo } from "@/components/ui/StepCommunitySparkLogo.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useStepCommunityStatus } from "@/hooks/useStepCommunityStatus.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { isStepFirstUseEndpointValid, stepFirstUseCompletionSettings, stepFirstUseCustomConfig } from "@/lib/stepFirstUse.js";
import { buildLoginApiKeyDefaultModelPreferenceFromSelection } from "@/login/LoginApiKeyForm.helpers.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { LoginCompleteReason } from "@/WelcomeScreen.js";
import { StepFirstUseFields, type StepFirstUseDraft, type StepFirstUseSource } from "./StepFirstUseFields.js";
import lightArt from "@/assets/step-welcome-light.png";
import darkArt from "@/assets/step-welcome-dark.png";
import "./step-first-use.css";

const emptyDraft = (): StepFirstUseDraft => ({ name: "", endpoint: "", model: "", key: "", apiType: "openai-chat-completions" });
const sources = ["subscription", "api", "custom"] as const;
const sourceIcons = { subscription: Sparkles, api: Braces, custom: Layers3 };

export function StepFirstUseWelcome({ onComplete }: { onComplete: (reason: LoginCompleteReason) => void | Promise<void> }) {
  const services = useServices();
  const platform = usePlatform();
  const { intl, locale } = useZCodeIntl();
  const { settings, update } = useSettings();
  const community = useStepCommunityStatus(services);
  const markConnected = useZCodeStore(state => state.markApiKeyLoginSuccess);
  const [page, setPage] = useState<"welcome" | "connect">(() => settings?.stepWelcomeCompleted || settings?.onboardingOccupation || settings?.lastWorkspaceSession?.length ? "connect" : "welcome");
  const [source, setSource] = useState<StepFirstUseSource>("subscription");
  const [drafts, setDrafts] = useState<Record<StepFirstUseSource, StepFirstUseDraft>>({ subscription: emptyDraft(), api: emptyDraft(), custom: emptyDraft() });
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(true);
  const [initialProviderAvailable, setInitialProviderAvailable] = useState(false);
  const [initialCustomAvailable, setInitialCustomAvailable] = useState(false);
  const [connected, setConnected] = useState<Partial<Record<StepFirstUseSource, boolean>>>({});
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const created = useRef<{ providerId: string; modelId?: string } | null>(null);
  const t = (key: string) => intl.formatMessage({ id: `step.firstUse.${key}` });

  useEffect(() => {
    let active = true;
    // 进入表单之前的正式 View 才代表已有配置；不能把失败尝试刚创建的 provider 当成已连接。
    void services.modelSelectionService.getView().then(view => {
      if (active) {
        setInitialProviderAvailable(view.providers.some(provider => provider.models.length > 0));
        setInitialCustomAvailable(view.providers.some(provider => !["step", "step-api", "step-plan"].includes(provider.providerId) && provider.models.length > 0));
      }
    }).catch(() => { if (active) setError(t("readFailed")); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
    // 文案与语言变化不重新声明已有连接，避免失败尝试被误识别成初始成功状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services.modelSelectionService]);

  const configured = (value: StepFirstUseSource) => connected[value] || (value === "custom" ? initialCustomAvailable : Boolean(community.configuredKeyTails?.[value]));
  const canContinue = initialProviderAvailable || Object.values(connected).some(Boolean) || Boolean(community.configuredKeyTails?.api || community.configuredKeyTails?.subscription);
  const changeSource = (next: StepFirstUseSource) => { setSource(next); setVisible(false); setError(null); setNotice(null); };
  const save = async () => {
    const draft = drafts[source];
    if (!draft.key.trim() || (source === "custom" && (!draft.name.trim() || !draft.model.trim() || !draft.endpoint.trim()))) { setError(t("required")); return; }
    if (source === "custom" && !isStepFirstUseEndpointValid(draft.endpoint)) { setError(t("invalidEndpoint")); return; }
    setPending(true); setError(null); setNotice(null);
    try {
      let providerId: string;
      if (source === "custom") {
        const config = stepFirstUseCustomConfig(draft.key, draft.endpoint, draft.apiType);
        if (!created.current) {
          const result = await services.providerSettingsService.createPersonalProvider({ providerName: draft.name.trim(), initialConfig: config });
          created.current = { providerId: result.providerId };
        } else {
          await services.providerSettingsService.savePersonalProviderOverlay(created.current.providerId, config, { providerName: draft.name.trim() });
        }
        providerId = created.current.providerId;
        if (created.current.modelId !== draft.model.trim()) {
          if (created.current.modelId) await services.providerSettingsService.renamePersonalModel(providerId, created.current.modelId, draft.model.trim());
          else await services.providerSettingsService.addPersonalModel(providerId, draft.model.trim(), {}, true);
          created.current.modelId = draft.model.trim();
        }
        const workspace = await services.fileService.ensureConversationWorkspace();
        const result = await services.providerSettingsService.testModelConnectivity({ workspacePath: workspace.path, providerId, modelId: draft.model.trim() });
        if (!result.success) throw new Error(result.error.message);
        created.current = null;
      } else {
        const result = await services.stepCommunityService?.validateAndStoreApiKey({ apiKey: draft.key.trim(), connectionMode: source });
        if (!result?.ok) throw new Error(result?.message || t("connectionFailed"));
        providerId = source === "api" ? "step-api" : "step-plan";
        window.dispatchEvent(new Event("step-community-profile-changed"));
      }
      setSelectedProvider(providerId);
      setConnected(value => ({ ...value, [source]: true }));
      setDrafts(value => ({ ...value, [source]: { ...value[source], key: "" } }));
      setVisible(false); setNotice(t("saved"));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("connectionFailed");
      setError(message.replaceAll(draft.key.trim(), "••••"));
    }
    finally { setPending(false); }
  };
  const finish = async (skip: boolean) => {
    setPending(true); setError(null);
    try {
      await update(stepFirstUseCompletionSettings(settings, locale, Date.now()));
      if (!skip && selectedProvider) markConnected(buildLoginApiKeyDefaultModelPreferenceFromSelection(await services.modelSelectionService.getView(), selectedProvider));
      await onComplete(skip ? "skip" : "apiKey");
    } catch (cause) {
      // 工作目录或完成回调失败时保留欢迎页；不能把未进入软件记成首次流程已经完成。
      await update({ stepWelcomeCompleted: settings?.stepWelcomeCompleted ?? false }).catch(() => {});
      setError(cause instanceof Error ? cause.message : t("finishFailed")); setPending(false);
    }
  };

  return (
    <main className="step-first-use" data-testid="step-first-use" data-page={page}>
      <div className="step-first-use-drag" aria-hidden="true" />
      <div className="step-first-use-shell">
        <header className="step-first-use-header">
          <div className="step-first-use-brand"><span className="step-first-use-brand-icon"><StepCommunitySparkLogo className="size-6" /></span><span className="text-ui-lg font-semibold">Step Code</span></div>
          <nav className="step-first-use-progress text-ui-caption" aria-label={t("progress")}><span aria-current={page === "welcome" ? "step" : undefined}>{t("welcomeStep")}</span><ArrowRight className="size-3" /><span aria-current={page === "connect" ? "step" : undefined}>{t("connectStep")}</span></nav>
        </header>
        <div className="step-first-use-body">
          <aside className="step-first-use-art-panel" aria-hidden="true">
            <div className="step-first-use-art"><img src={lightArt} alt="" className="step-first-use-art-light" /><img src={darkArt} alt="" className="step-first-use-art-dark" /></div>
            <div className="step-first-use-orbit"><span /><span /><i /><i /><i /></div>
            <div className="step-first-use-art-caption"><span className="text-ui-caption">STEP CODE</span><p className="text-ui-lg font-medium">{t("artCaption")}</p></div>
          </aside>
          <section className="step-first-use-content" aria-label={t(page === "welcome" ? "welcomeTitle" : "connectTitle")}>
            {page === "welcome" ? <>
              <span className="step-first-use-eyebrow text-ui-caption"><Sparkles className="size-3.5" />{t("eyebrow")}</span>
              <h1 className="text-ui-xl font-semibold">{t("welcomeTitle")}</h1>
              <p className="step-first-use-description text-ui-base">{t("welcomeDescription")}</p>
              <div className="step-first-use-features">{([[Braces, "featureCode"], [Files, "featureFiles"], [Layers3, "featureWorkflow"]] as const).map(([Icon, key]) => <div key={key}><Icon className="size-4" /><span className="text-ui-base">{t(key)}</span></div>)}</div>
              <div className="step-first-use-welcome-actions"><Button size="lg" className="step-first-use-primary" disabled={pending || checking} data-testid="step-welcome-connect" onClick={() => setPage("connect")}>{t("connectModels")}<ArrowRight className="size-4" /></Button><Button variant="ghost" disabled={pending} onClick={() => void finish(true)} data-testid="step-welcome-skip">{t("later")}</Button></div>
              <p className="step-first-use-footnote text-ui-caption">{t("welcomeFootnote")}</p>
            </> : <>
              <Button variant="ghost" size="sm" className="step-first-use-back" disabled={pending} onClick={() => setPage("welcome")}><ArrowLeft className="size-3.5" />{t("back")}</Button>
              <h1 className="text-ui-xl font-semibold">{t("connectTitle")}</h1>
              <p className="step-first-use-description text-ui-base">{t("connectDescription")}</p>
              <div className="step-first-use-source-grid">{sources.map(value => { const Icon = sourceIcons[value]; return <button key={value} type="button" className="step-first-use-source" data-selected={source === value} data-testid={`step-welcome-source-${value}`} aria-pressed={source === value} disabled={pending || checking} onClick={() => changeSource(value)}><Icon className="size-5" /><span className="text-ui-base font-semibold">{t(`${value}Title`)}</span><span className="text-ui-caption">{configured(value) ? <><Check className="size-3" />{t(connected[value] ? "connected" : "configured")}</> : t(`${value}Caption`)}</span></button>; })}</div>
              <form className="step-first-use-form" onSubmit={e => { e.preventDefault(); void save(); }}>
                <div className="step-first-use-form-heading"><span className="text-ui-base font-medium">{t(`${source}FormTitle`)}</span>{source !== "custom" ? <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => platform.openExternal(source === "subscription" ? "https://platform.stepfun.com/step-plan" : "https://platform.stepfun.com/interface-key")}>{t("getKey")}<ArrowUpRight className="size-3" /></Button> : null}</div>
                <StepFirstUseFields source={source} draft={drafts[source]} pending={pending} visible={visible} onToggleVisibility={() => setVisible(v => !v)} onChange={patch => setDrafts(value => ({ ...value, [source]: { ...value[source], ...patch } }))} />
                <p className="step-first-use-form-help text-ui-caption">{t(`${source}Help`)}</p>
                <Button type="submit" variant="outline" disabled={pending || checking} data-testid="step-welcome-save">{pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}{t(pending ? "connecting" : "saveConnection")}</Button>
              </form>
              {notice ? <div className="step-first-use-notice text-ui-caption" role="status"><CheckCircle2 className="size-4" />{notice}</div> : null}
              <div className="step-first-use-connect-actions"><Button className="step-first-use-primary" disabled={!canContinue || pending || checking} data-testid="step-welcome-continue" onClick={() => void finish(false)}>{t("enterApp")}<ArrowRight className="size-4" /></Button><Button variant="ghost" disabled={pending} data-testid="step-welcome-skip" onClick={() => void finish(true)}>{t("later")}</Button></div>
            </>}
            {error ? <p className="step-first-use-error text-ui-caption" role="alert">{error}</p> : null}
          </section>
        </div>
        <footer className="step-first-use-footer text-ui-caption"><span>{t("footer")}</span><span>{t("preferencesOptional")}</span></footer>
      </div>
    </main>
  );
}
