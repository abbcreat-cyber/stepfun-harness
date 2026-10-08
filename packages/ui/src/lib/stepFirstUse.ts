import type { AppSettings } from "@zcode/shared";

export function shouldShowStepFirstUse(settings: Pick<AppSettings, "stepWelcomeCompleted" | "onboardingOccupation" | "lastWorkspaceSession"> | null | undefined, active: boolean): boolean {
  return Boolean(active && settings && !settings.stepWelcomeCompleted && !settings.onboardingOccupation && !settings.lastWorkspaceSession?.length);
}

/** 稍后设置只完成引导，不把无 Key 的状态改写成登录成功。 */
export function stepFirstUseCompletionSettings(settings: Pick<AppSettings, "providerFamilyDomain"> | null | undefined, locale: string, now: number): Partial<AppSettings> {
  return {
    stepWelcomeCompleted: true,
    providerFamilyDomain: settings?.providerFamilyDomain ?? (locale.startsWith("zh") ? "bigmodel" : "zai"),
    providerFamilyDomainMigrated: true,
    providerFamilyDomainUpdatedAt: now,
  };
}

export function isStepFirstUseEndpointValid(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

/** Provider 的 group 由配置服务确定，创建/覆盖接口不能由前端指定。 */
export function stepFirstUseCustomConfig(apiKey: string, baseUrl: string, apiType: "openai-chat-completions" | "anthropic-messages") {
  return { access: { type: "api-key" as const, apiKey: apiKey.trim() }, api: { type: apiType, baseUrl: baseUrl.trim() }, visibility: "visible" as const };
}
