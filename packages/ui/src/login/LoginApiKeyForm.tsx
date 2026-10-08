import { useEffect, useState } from "react";
import { isApiKeyAccess } from "@zcode/provider";
import type { IServiceAccessor } from "@zcode/services";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import {
  BIGMODEL_PROVIDER_ID,
  TID_LOGIN_API_KEY_CANCEL_BUTTON,
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_ERROR,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_API_KEY_PROVIDER_ITEM,
  TID_LOGIN_API_KEY_PROVIDER_TRIGGER,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  ZAI_PROVIDER_ID,
  testId,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { renderOAuthProviderIcon } from "@/lib/oauthProviderIcon.js";
import {
  buildLoginApiKeyDefaultModelPreferenceFromSelection,
  buildLoginApiKeySkipSettings,
  resolveLoginApiKeyDefaultProvider,
  resolveLoginApiKeyTemplateId,
  resolveLoginApiKeyProviderLabel,
  shouldShowLoginApiKeyLink,
  type ApiKeyProviderChoice,
} from "@/login/LoginApiKeyForm.helpers.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/** Step-Code 社区模式的阶跃星辰 API Key 获取入口（与 Step CLI platform_cn profile 的 keyPageUrl 同源）。 */
const STEP_COMMUNITY_API_KEY_MANAGEMENT_URL = "https://platform.stepfun.com/interface-key";
/** Step-Code 社区模式下注入 provider 的 id（与 host 侧 stepCommunityModelSelection 的常量一致）。 */
const STEP_COMMUNITY_PROVIDER_ID = "step";

/** mount 时读取 Step-Code 社区后端状态：active=true 时表单走阶跃星辰 API Key 校验/落盘路径。 */
function useStepCommunityStatus(services: IServiceAccessor): {
  status: "unknown" | "active" | "inactive";
} {
  const [status, setStatus] = useState<"unknown" | "active" | "inactive">("unknown");
  useEffect(() => {
    let disposed = false;
    void services.stepCommunityService
      ?.getStatus()
      .then((result) => {
        if (!disposed) setStatus(result.active ? "active" : "inactive");
      })
      .catch((error: unknown) => {
        // 上游环境/旧 server wire 未注册该频道时回落官方路径，不让登录入口整体挂掉。
        logger.warn("[LoginEntry] Step 社区后端状态读取失败，回落官方 API Key 路径", {
          error,
        });
        if (!disposed) setStatus("inactive");
      });
    return () => {
      disposed = true;
    };
  }, [services.stepCommunityService]);
  return { status };
}

interface LoginApiKeyFormProps {
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onSkipped: () => void | Promise<void>;
}

export function LoginApiKeyForm({ onCancel, onSaved, onSkipped }: LoginApiKeyFormProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const services = useServices();
  const { modelSelectionService, providerSettingsService, settingService } = services;
  const { stepCommunityService } = services;
  const markApiKeyLoginSuccess = useZCodeStore((state) => state.markApiKeyLoginSuccess);
  const { status: stepCommunityStatus } = useStepCommunityStatus(services);
  // 社区模式（STEP_BACKEND=stepcode-local）：表单只服务阶跃星辰；上游（inactive/unknown）路径保持原样。
  const stepCommunityActive = stepCommunityStatus === "active";
  const [providerChoice, setProviderChoice] = useState<ApiKeyProviderChoice>(() =>
    resolveLoginApiKeyDefaultProvider(locale),
  );
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;

  const providerLabel = resolveLoginApiKeyProviderLabel(providerChoice);
  const templateId = resolveLoginApiKeyTemplateId(providerChoice);
  const templateAccess = providerSettingsView?.providerTemplates.find(
    (template) => template.templateId === templateId,
  )?.config.access;
  const officialApiKeyUrl = isApiKeyAccess(templateAccess)
    ? templateAccess.apiKeyManagementUrl
    : undefined;
  // 社区模式的 key 获取入口指向阶跃星辰平台（Step CLI platform_cn profile 的 keyPageUrl）。
  const apiKeyUrl = stepCommunityActive
    ? STEP_COMMUNITY_API_KEY_MANAGEMENT_URL
    : officialApiKeyUrl;
  // 用户已经输入或回填 API Key 后，右侧获取入口会挤占密码输入区域。
  const showApiKeyLink = shouldShowLoginApiKeyLink(apiKeyValue, apiKeyUrl ?? undefined);

  // Step-Code 社区路径：先真实校验（GET api.stepfun.com/v1/models），通过后写入 CLI 的
  // auth.json 并由 host 侧激活 step provider 注入；失败优先显示 services 返回的中文
  // message（含真实原因，如"凭据文件已损坏（路径）"——本地写盘故障不能被误报成网络故障），
  // 无 message 再按 code 落 i18n 兜底文案，欢迎页不关。
  const saveStepCommunityApiKey = async () => {
    const apiKey = apiKeyValue.trim();
    if (!apiKey) {
      setError(intl.formatMessage({ id: "login.apiKey.emptyError" }));
      return;
    }
    if (!stepCommunityService) {
      // 理论上不可达（状态为 active 时服务必在）；防御性回落官方路径文案。
      setError(intl.formatMessage({ id: "login.apiKey.saveError" }, { error: "服务不可用" }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const outcome = await stepCommunityService.validateAndStoreApiKey({ apiKey });
      if (!outcome.ok) {
        // message 是 services 侧成型的完整中文句（含真实失败原因），优先原样展示；
        // 仅当 message 缺失（不应发生）才按 code 显示通用 i18n 文案。
        // 否则本地写盘失败（auth.json 损坏等）会被 code:"network" 的"检查网络"文案误导排查方向。
        setError(
          outcome.message ||
            intl.formatMessage({
              id: outcome.code === "invalid" ? "login.apiKey.stepInvalid" : "login.apiKey.stepNetwork",
            }),
        );
        return;
      }
      // host 侧已激活注入：从最新 View 读取 step provider 的首个模型作为偏好记录（与官方路径同款工具函数）。
      const defaultModelPreference = buildLoginApiKeyDefaultModelPreferenceFromSelection(
        await modelSelectionService.getView(),
        STEP_COMMUNITY_PROVIDER_ID,
      );
      markApiKeyLoginSuccess(defaultModelPreference);
      await onSaved();
    } catch (saveError) {
      logger.error("[LoginEntry] 保存阶跃星辰 API Key 失败", {
        error: saveError,
      });
      // 非 401/403 的意外异常（RPC 断开/本地写盘故障等）沿用官方路径的通用错误模板。
      setError(
        intl.formatMessage(
          { id: "login.apiKey.saveError" },
          {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const saveApiKeyProvider = async () => {
    if (stepCommunityActive) {
      await saveStepCommunityApiKey();
      return;
    }
    const apiKey = apiKeyValue.trim();
    if (!apiKey) {
      setError(intl.formatMessage({ id: "login.apiKey.emptyError" }));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const template = (await providerSettingsService.getView()).providerTemplates.find(
        (item) => item.templateId === templateId,
      );
      if (!template || !isApiKeyAccess(template.config.access)) {
        setError(
          intl.formatMessage(
            { id: "login.apiKey.providerMissingError" },
            { provider: providerLabel },
          ),
        );
        return;
      }

      const created = await providerSettingsService.createPersonalProvider({
        templateId,
        initialConfig: { access: { type: template.config.access.type, apiKey } },
      });
      const defaultModelPreference = buildLoginApiKeyDefaultModelPreferenceFromSelection(
        await modelSelectionService.getView(),
        created.providerId,
      );
      markApiKeyLoginSuccess(defaultModelPreference);
      await onSaved();
    } catch (saveError) {
      logger.error("[LoginEntry] 保存 API Key provider 失败", {
        templateId,
        error: saveError,
      });
      setError(
        intl.formatMessage(
          { id: "login.apiKey.saveError" },
          {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const skipApiKeyProvider = async () => {
    setSkipping(true);
    setError(null);
    try {
      // 跳过只表示用户确认当前 provider family 运行域，不能写入空 API Key
      // 或触发 API Key 登录成功事件，否则后续模型选择会误以为已有可用凭据。
      await settingService.update(buildLoginApiKeySkipSettings(providerChoice, Date.now()));
      await onSkipped();
    } catch (skipError) {
      logger.error("[LoginEntry] 跳过 API Key 登录失败", {
        providerChoice,
        error: skipError,
      });
      setError(
        intl.formatMessage(
          { id: "login.apiKey.skipError" },
          {
            error: skipError instanceof Error ? skipError.message : String(skipError),
          },
        ),
      );
    } finally {
      setSkipping(false);
    }
  };

  const busy = saving || skipping;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "login.apiKey.title" })}
        </h2>
        <div className="space-y-2">
          <div>
            {/* 社区模式（阶跃星辰）下没有 zai/bigmodel 供应商选择，隐藏下拉框只保留 key 输入。 */}
            {stepCommunityActive ? (
              <div
                className="flex h-10 w-full items-center gap-2 rounded-lg border border-input bg-surface px-3 text-ui-base text-foreground-subtle"
                data-testid={TID_LOGIN_API_KEY_PROVIDER_TRIGGER}
              >
                {intl.formatMessage({ id: "login.apiKey.provider.step" })}
              </div>
            ) : (
              <Select
                value={providerChoice}
                onValueChange={(value) => setProviderChoice(value as ApiKeyProviderChoice)}
                disabled={busy}
              >
                <SelectTrigger
                  id="login-api-key-provider"
                  size="lg"
                  className="h-10 w-full text-ui-base"
                  data-testid={TID_LOGIN_API_KEY_PROVIDER_TRIGGER}
                  aria-label={intl.formatMessage({
                    id: "login.apiKey.providerLabel",
                  })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" className="rounded-lg">
                  <SelectItem
                    value="zai"
                    className="rounded-md"
                    data-testid={testId(TID_LOGIN_API_KEY_PROVIDER_ITEM, "zai")}
                  >
                    {renderOAuthProviderIcon(ZAI_PROVIDER_ID, "size-4")}
                    {intl.formatMessage({ id: "login.apiKey.provider.zai" })}
                  </SelectItem>
                  <SelectItem
                    value="bigmodel"
                    className="rounded-md"
                    data-testid={testId(TID_LOGIN_API_KEY_PROVIDER_ITEM, "bigmodel")}
                  >
                    {renderOAuthProviderIcon(BIGMODEL_PROVIDER_ID, "size-4")}
                    {intl.formatMessage({
                      id: "login.apiKey.provider.bigmodel",
                    })}
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="relative">
            <Input
              id="login-api-key"
              type="password"
              size="lg"
              className={`h-10 w-full text-ui-base ${showApiKeyLink ? "pr-28" : ""}`}
              data-testid={TID_LOGIN_API_KEY_INPUT}
              aria-label={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              value={apiKeyValue}
              placeholder={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              autoComplete="off"
              onChange={(event) => {
                setApiKeyValue(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && apiKeyValue.trim() && !busy) {
                  void saveApiKeyProvider();
                }
              }}
            />
            {showApiKeyLink ? (
              <button
                type="button"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ui-base font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  if (apiKeyUrl) {
                    platform.openExternal(apiKeyUrl);
                  }
                }}
              >
                {intl.formatMessage({ id: "login.apiKey.getApiKey" })}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" data-testid={TID_LOGIN_API_KEY_ERROR}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Button
          type="button"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_CONTINUE_BUTTON}
          disabled={!apiKeyValue.trim() || busy}
          onClick={() => void saveApiKeyProvider()}
        >
          {saving ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.apiKey.continue" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_CANCEL_BUTTON}
          disabled={busy}
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "login.apiKey.cancel" })}
        </Button>
        <Button
          type="button"
          variant="link"
          className="h-7 w-full text-ui-base text-foreground-subtle hover:text-foreground"
          data-testid={TID_LOGIN_API_KEY_SKIP_BUTTON}
          disabled={busy}
          onClick={() => void skipApiKeyProvider()}
        >
          {skipping ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.skip" })}
        </Button>
      </div>
    </div>
  );
}
