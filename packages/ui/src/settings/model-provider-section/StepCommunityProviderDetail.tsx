import { useState } from "react";
import { ArrowUpRight, Braces, Check, Loader2Icon, Sparkles } from "lucide-react";
import type { StepCommunityStatus } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/index.js";
import type { StepCommunityUiState } from "@/hooks/useStepCommunityStatus.js";
import lightArt from "@/assets/step-welcome-light.png";
import darkArt from "@/assets/step-welcome-dark.png";
import { ApiKeyInput } from "./ApiKeyInput.js";
import "./step-community-connections.css";

type ConnectionMode = "subscription" | "api";

export function StepCommunityProviderDetail({ community }: { community: StepCommunityUiState }) {
  const services = useServices();
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [saved, setSaved] = useState<StepCommunityStatus | null>(null);
  const status = saved ?? community;
  return (
    <div className="step-connections-console" data-testid="model-provider-step-community-detail">
      <div className="step-connections-backdrop" aria-hidden="true">
        <img
          src={lightArt}
          alt=""
          className="step-connections-art step-connections-art-light"
          draggable={false}
        />
        <img
          src={darkArt}
          alt=""
          className="step-connections-art step-connections-art-dark"
          draggable={false}
        />
        <div className="step-connections-stars">
          {Array.from({ length: 8 }, (_, index) => (
            <i key={index} />
          ))}
        </div>
        <span className="step-connections-light-trace" />
      </div>
      <header className="step-connections-heading">
        <span className="step-connections-brand text-ui-caption">
          <Sparkles className="size-3.5" />
          STEPFUN
        </span>
        <h2 className="text-ui-xl font-semibold">
          {intl.formatMessage({ id: "settings.modelProvider.stepCommunity.designTitle" })}
        </h2>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.stepCommunity.designDescription" })}
        </p>
      </header>
      <div className="step-connections-grid">
        {(["subscription", "api"] as const).map((mode) => (
          <StepConnectionCard
            key={mode}
            mode={mode}
            active={Boolean(status.configuredKeyTails?.[mode])}
            tail={
              status.configuredKeyTails?.[mode] ??
              ((status.connectionMode ?? "api") === mode ? status.apiKeyTail : undefined)
            }
            onOpen={() =>
              platform.openExternal(
                mode === "subscription"
                  ? "https://platform.stepfun.com/step-plan"
                  : "https://platform.stepfun.com/interface-key",
              )
            }
            onSave={async (key, useSaved) => {
              if (!services.stepCommunityService)
                throw new Error(
                  intl.formatMessage({
                    id: "settings.modelProvider.stepCommunity.serviceUnavailable",
                  }),
                );
              const result = await services.stepCommunityService.validateAndStoreApiKey({
                apiKey: key,
                connectionMode: mode,
                useSaved,
              });
              if (!result.ok)
                throw new Error(
                  result.message ||
                    intl.formatMessage({
                      id: "settings.modelProvider.stepCommunity.validationFailed",
                    }),
                );
              setSaved(await services.stepCommunityService.getStatus());
              window.dispatchEvent(new Event("step-community-profile-changed"));
            }}
          />
        ))}
      </div>
    </div>
  );
}

function StepConnectionCard({
  mode,
  active,
  tail,
  onOpen,
  onSave,
}: {
  mode: ConnectionMode;
  active: boolean;
  tail?: string;
  onOpen: () => void;
  onSave: (key: string, useSaved: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const subscription = mode === "subscription";
  const title = intl.formatMessage({
    id: subscription
      ? "settings.modelProvider.stepCommunity.planTitle"
      : "settings.modelProvider.stepCommunity.apiTitle",
  });
  const save = async (useSaved = false) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await onSave(value.trim(), useSaved);
      setValue("");
      setVisible(false);
      setNotice(intl.formatMessage({ id: "settings.modelProvider.stepCommunity.connectionSaved" }));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : intl.formatMessage({ id: "settings.modelProvider.stepCommunity.validationFailed" }),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      className="step-connection-card"
      data-connection={mode}
      data-testid={`step-${mode}-card`}
      aria-label={title}
    >
      <div className="step-connection-card-heading">
        <span className="step-connection-icon" aria-hidden="true">
          {subscription ? <Sparkles className="size-5" /> : <Braces className="size-5" />}
        </span>
        <h3 className="text-ui-lg font-semibold">{title}</h3>
        <span className="step-connection-state text-ui-caption" data-connected={active}>
          {active && <Check className="size-3" aria-hidden="true" />}
          {intl.formatMessage({
            id: active
              ? "settings.modelProvider.stepCommunity.stateConnected"
              : "settings.modelProvider.stepCommunity.stateEmpty",
          })}
        </span>
      </div>
      <p className="step-connection-description text-ui-base text-foreground-subtle">
        {intl.formatMessage({
          id: subscription
            ? "settings.modelProvider.stepCommunity.planUsage"
            : "settings.modelProvider.stepCommunity.apiUsage",
        })}
      </p>
      <div className="step-connection-form">
        <div className="step-connection-key-label text-ui-caption text-foreground-subtle">
          {intl.formatMessage({
            id: subscription
              ? "settings.modelProvider.stepCommunity.planKeyLabel"
              : "settings.modelProvider.stepCommunity.apiKeyLabel",
          })}
        </div>
        <ApiKeyInput
          value={value}
          visible={visible}
          readOnly={pending}
          testId={`step-${mode}-key-input`}
          label={title}
          placeholderId={
            subscription
              ? "settings.modelProvider.stepCommunity.subscriptionKeyPlaceholder"
              : "settings.modelProvider.stepCommunity.apiInputPlaceholder"
          }
          onChange={setValue}
          onBlur={() => {}}
          onToggleVisibility={() => setVisible(!visible)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim() && !pending) void save();
          }}
        />
        <Button
          type="button"
          className="step-connection-connect"
          disabled={pending || !value.trim()}
          onClick={() => void save()}
          data-testid={`step-${mode}-connect`}
        >
          {pending ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          {intl.formatMessage({
            id: pending
              ? "settings.modelProvider.stepCommunity.validating"
              : "settings.modelProvider.stepCommunity.connectAction",
          })}
        </Button>
      </div>
      <footer className="step-connection-footer">
        <span className="text-ui-caption text-foreground-subtle">
          {tail
            ? `····${tail}`
            : intl.formatMessage({ id: "settings.modelProvider.stepCommunity.keyRequired" })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="step-connection-manage"
          onClick={onOpen}
        >
          {intl.formatMessage({
            id: subscription
              ? "settings.modelProvider.stepCommunity.managePlan"
              : "settings.modelProvider.stepCommunity.getApiKey",
          })}
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Button>
      </footer>
      {error && (
        <p role="alert" className="step-connection-feedback text-ui-base text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="step-connection-feedback text-ui-base text-foreground-subtle">
          {notice}
        </p>
      )}
    </section>
  );
}
