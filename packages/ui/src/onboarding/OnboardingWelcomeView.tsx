import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { StepCommunitySparkLogo } from "@/components/ui/StepCommunitySparkLogo.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useStepCommunityStatus } from "@/hooks/useStepCommunityStatus.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { OnboardingWelcomeAsciiVisual } from "@/onboarding/OnboardingWelcomeAsciiVisual.js";

export function OnboardingWelcomeView(props: { onStart: () => void; onOpenMigration: () => void }) {
  const { intl } = useZCodeIntl();
  // Step-Code 社区模式：logo 换社区四角星、壳 aria-label 同步；非社区模式（含查询
  // 失败回落）保持上游 Z 字标，渲染输出与上游一致（铁律 1）。
  const services = useOptionalServices();
  const stepCommunity = useStepCommunityStatus(services);
  const stepCommunityActive = stepCommunity.status === "active";

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-1/2 flex-col px-8 py-8">
        <div className="space-y-6">
          <div className="inline-flex items-center rounded-full border border-border bg-background-alt px-3 py-1 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "onboarding.welcome.eyebrow" })}
          </div>

          <div className="space-y-2">
            {/* 欢迎 logo 壳是固定深色底，边框不能跟随浅色主题 token，否则浅色主题下边框过重。*/}
            <div
              className="relative flex size-14 items-center justify-center rounded-xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-lg/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-xl before:border before:border-[rgba(255,255,255,0.1)]"
              aria-label={stepCommunityActive ? "Step-Code" : "ZCode"}
              role="img"
            >
              {stepCommunityActive ? (
                <StepCommunitySparkLogo className="h-auto w-8" />
              ) : (
                <ZCodeAboutLogo className="h-auto w-8" />
              )}
            </div>
            <div className="text-4xl font-bold tracking-tight text-foreground">
              {intl.formatMessage({ id: "onboarding.welcome.title" })}
            </div>
          </div>
        </div>

        <div className="flex flex-1 items-center">
          <div className="w-full space-y-4">
            <Button
              type="button"
              size="lg"
              className="h-10 w-full justify-between text-ui-base"
              onClick={props.onStart}
            >
              {intl.formatMessage({ id: "onboarding.welcome.start" })}
              <ArrowRightIcon className="size-4" />
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="h-10 w-full justify-between text-ui-base"
              onClick={props.onOpenMigration}
            >
              {intl.formatMessage({ id: "onboarding.welcome.migrate" })}
              <ArrowRightIcon className="size-4" />
            </Button>
          </div>
        </div>

        <div className="pt-6 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "onboarding.welcome.helper" })}
        </div>
      </div>

      <div className="flex w-1/2 flex-col p-2 pl-0">
        <OnboardingWelcomeAsciiVisual />
      </div>
    </div>
  );
}
