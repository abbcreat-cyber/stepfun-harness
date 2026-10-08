import { StepProfileNameDialog } from "@/StepProfileNameDialog.js";
/* oxlint-disable eslint(max-lines) -- footer 聚合账户、主题、模式和快捷键菜单。 */
import type { Locale, UserInfo } from "@zcode/shared";
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  DesktopCommandIds,
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_TRIGGER,
  TID_LOGOUT_BUTTON,
  TID_SIDEBAR_STEP_COMMUNITY_BALANCE,
  TID_SIDEBAR_STEP_COMMUNITY_CHIP,
  TID_SIDEBAR_STEP_COMMUNITY_MENU_ENTER_KEY,
  TID_SIDEBAR_STEP_COMMUNITY_MENU_MANAGE_KEY,
  TID_SIDEBAR_STEP_COMMUNITY_MENU_REPLACE_KEY,
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { StepCommunitySparkLogo } from "@/components/ui/StepCommunitySparkLogo.js";
import "./step-profile-menu.css";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  ChevronRight,
  ExternalLink,
  KeyRound,
  PencilRuler,
  Globe,
  Loader2,
  LogInIcon,
  LogOut,
  Maximize,
  Palette,
  Settings,
  Sparkles,
  User,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useStepCommunityBalance } from "@/hooks/useStepCommunityBalance.js";
import { useStepCommunityStatus } from "@/hooks/useStepCommunityStatus.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { formatStepAmount, resolveStepCommunityBalanceView } from "@/lib/stepCommunityBalance.js";
import { normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";
import { WorkspaceWebRemoteControlTrigger } from "@/WorkspaceWebRemoteControlTrigger.js";
import {
  WorkspaceSidebarFooterPlanBadge,
  WorkspaceSidebarFooterUsageSummaryContent,
  useWorkspaceSidebarFooterUsageSummaryState,
} from "@/WorkspaceSidebarFooterUsageSummary.js";

const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;
/** Step-Code 社区模式的阶跃星辰密钥管理入口（与 LoginApiKeyForm 的 keyPageUrl 同源）。 */
const STEP_COMMUNITY_KEY_MANAGEMENT_URL = "https://platform.stepfun.com/interface-key";

function getSidebarProfileName(user?: UserInfo | null): string {
  const displayName = user?.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const username = user?.username?.trim();
  if (username) {
    return username;
  }

  return "ZCode";
}

function getSidebarProfileBadge(
  user: UserInfo | null | undefined,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  if (user) {
    return getSidebarProfileName(user);
  }

  return formatMessage({ id: "sidebar.profile.notLoggedIn" });
}

function getAvatarFallbackText(user: UserInfo | null | undefined): string {
  const source = user?.displayName?.trim() || user?.username?.trim() || "Z";
  return source[0]?.toUpperCase() ?? "Z";
}

export const WorkspaceSidebarFooter = memo(function WorkspaceSidebarFooterComponent({
  theme,
  localeMenuValue,
  onLocaleChange,
  onThemeChange,
  onSettingsButtonClick,
  onUsageClick,
  onLogin,
  onLogout,
  settingsButtonMode = "settings",
  user,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  isDesktop = false,
  className,
}: {
  theme: Theme;
  localeMenuValue: Locale | "system";
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onSettingsButtonClick?: () => void;
  onUsageClick?: () => void;
  onLogin?: () => void;
  onLogout?: () => void;
  settingsButtonMode?: "settings" | "back";
  user?: UserInfo | null;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId?: string | null;
  isDesktop?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  // Step-Code 社区模式（阶跃星辰）：唯一条件是 getStatus().active；unknown/inactive
  // 时下面的身份分支逐字节回到上游渲染，官方路径零改动。key 尾 4 位掩码由 host 侧
  // 派生（useStepCommunityStatus），完整 key 绝不进 renderer。
  const services = useOptionalServices();
  const stepCommunity = useStepCommunityStatus(services);
  const stepCommunityActive = stepCommunity.status === "active";
  const [renameOpen, setRenameOpen] = useState(false);
  const communityDisplayName = stepCommunity.displayName || "阶跃星辰用户";
  const stepCommunityConnected = stepCommunityActive && stepCommunity.keySource !== "none";
  const stepApiConnected = stepCommunityActive && Boolean(stepCommunity.configuredKeyTails?.api);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const footerRef = useRef<HTMLElement | null>(null);
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [profileMenuBounds, setProfileMenuBounds] = useState<{
    element: Element;
    width: number;
  } | null>(null);
  useEffect(() => {
    const footer = footerRef.current,
      trigger = profileTriggerRef.current;
    if (!stepCommunityActive || !footer || !trigger) return;
    const boundary = footer.closest("aside") ?? footer;
    const measure = () => {
      // Portal 不继承侧栏的 overflow；必须用真实侧栏边界约束弹层，而不是整个窗口。
      const width = Math.max(
        1,
        boundary.getBoundingClientRect().right - trigger.getBoundingClientRect().left - 8,
      );
      setProfileMenuBounds((previous) =>
        previous?.element === boundary && Math.abs(previous.width - width) < 0.5
          ? previous
          : { element: boundary, width },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(boundary);
    observer.observe(footer);
    observer.observe(trigger);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [stepCommunityActive, profileMenuOpen]);
  // 菜单常驻挂载，按实际展开状态发请求；每次重开都刷新，启动期网络失败不再永久隐藏。
  // 阶跃星辰账户余额只读行（docs/step-account-balance-spec.md）：仅已接入 API Key 时按需拉取，
  // 失败/non-api 连接模式由 resolveStepCommunityBalanceView 裁决成 error/hidden，整行不渲染。
  const stepBalance = useStepCommunityBalance(services, profileMenuOpen && stepApiConnected);
  const stepBalanceView = resolveStepCommunityBalanceView({
    active: stepCommunityActive,
    connected: stepApiConnected,
    loading: stepBalance.loading,
    balance: stepBalance.balance,
  });
  const stepBalanceRowStatus = stepBalanceView.status;
  const showStepBalanceRow = stepCommunityActive && stepBalanceRowStatus !== "hidden";
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const zoomInShortcutLabel = useShortcutCommandLabel("zoomIn");
  const zoomOutShortcutLabel = useShortcutCommandLabel("zoomOut");
  const resetZoomShortcutLabel = useShortcutCommandLabel("resetZoom");
  const isRestoringOAuthSession = useZCodeStore((state) => state.isRestoringOAuthSession);
  const profileBadge = getSidebarProfileBadge(user, intl.formatMessage);
  const avatarFallbackText = getAvatarFallbackText(user);
  const avatarKey = user?.avatarUrl ?? user?.id ?? "guest";
  const showAuthRestoreLoading = !user && isRestoringOAuthSession;
  const usageSummaryState = useWorkspaceSidebarFooterUsageSummaryState({
    enabled: true,
    workspaceIdentity,
    workspacePath,
  });
  const profileContent = stepCommunityActive ? (
    <>
      <Avatar size="default">
        <AvatarFallback className="bg-brand/10 text-brand">
          <Sparkles className="size-4" aria-hidden="true" />
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-left text-ui-base font-medium text-foreground">
        {communityDisplayName}
      </span>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          stepCommunityConnected ? "bg-success" : "bg-foreground-subtlest",
        )}
        title={stepCommunityConnected ? "已连接" : "未连接"}
        aria-label={stepCommunityConnected ? "已连接" : "未连接"}
      />
    </>
  ) : (
    <>
      <Avatar key={avatarKey} size="default">
        {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={profileBadge} /> : null}
        <AvatarFallback className="bg-background text-foreground">
          {user ? (
            avatarFallbackText
          ) : showAuthRestoreLoading ? (
            <>
              {/* OAuth 启动恢复未落定前，footer 之前会直接显示未登录头像，
                  用户很容易把“还在校验”误判成“已经退出”。
                  这里用 loading 图标明确表达“状态确认中”，等恢复成功或失败后再展示最终状态。 */}
              <Loader2 className="size-4 animate-spin" />
              <span className="sr-only">{intl.formatMessage({ id: "common.loading" })}</span>
            </>
          ) : (
            <User className="size-4" />
          )}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 overflow-hidden text-left">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-semibold text-foreground">
            {profileBadge}
          </span>
          {user ? <WorkspaceSidebarFooterPlanBadge state={usageSummaryState} /> : null}
        </div>
      </div>
    </>
  );
  const settingsButtonLabel =
    settingsButtonMode === "back"
      ? intl.formatMessage({ id: "workspace.backToWorkspace" })
      : intl.formatMessage({ id: "settings.title" });
  const usageButtonClick = onUsageClick ?? onSettingsButtonClick;
  const [desktopZoomLevel, setDesktopZoomLevel] = useState(0);
  const runDesktopZoomCommand = useCallback(
    (command: (typeof DesktopCommandIds)["ZoomIn" | "ZoomOut" | "ResetZoom"]) => {
      void platform.executeDesktopCommand(command);
    },
    [platform],
  );

  useEffect(() => {
    if (!isDesktop) {
      setDesktopZoomLevel(0);
      return;
    }

    let isCancelled = false;
    void platform.getDesktopZoomLevel?.().then((state) => {
      if (!isCancelled && Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    const dispose = platform.onDesktopZoomLevelChanged?.((state) => {
      if (Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    return () => {
      isCancelled = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  const canResetDesktopZoom = desktopZoomLevel !== 0;
  const canZoomIn = desktopZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = desktopZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;
  // 社区菜单动作：跳设置页模型供应商分区（社区模式下预设组唯一项即阶跃星辰卡，
  // 选中默认落在本节点）；设置页入口不可用时只登记意图，不弹错误。
  const openStepCommunitySettings = useCallback(() => {
    setProfileMenuOpen(false);
    setPendingSettingsSection("modelProvider");
    onSettingsButtonClick?.();
  }, [onSettingsButtonClick]);

  return (
    // footer 被 Settings 复用，页面专属边距由调用方传入，避免修改共享默认样式。
    <footer
      ref={footerRef}
      className={cn("flex shrink-0 flex-col gap-2.5 px-4 pt-2 pb-4", className)}
    >
      {isDesktop ? (
        <div className="flex items-center gap-1.5" data-testid="sidebar-tools-row">
          {workspacePath ? (
            <WorkspaceWebRemoteControlTrigger
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              compact
            />
          ) : null}
          {stepCommunityActive && platform.toggleStepMini ? (
            <ControlHintTooltip title={intl.formatMessage({ id: "sidebar.stepMini.toggle" })}>
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                data-testid="step-mini-toggle"
                aria-label={intl.formatMessage({ id: "sidebar.stepMini.toggle" })}
                onClick={() => void platform.toggleStepMini?.()}
              >
                <Sparkles className="size-4" />
              </Button>
            </ControlHintTooltip>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 gap-2">
        <DropdownMenu open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
          <DropdownMenuTrigger asChild>
            {/* 头像和 Login 之前直接绑定到登录动作，导致用户无法从这里打开偏好设置。
              现在把这一块改成统一的设置菜单入口，登录/退出留在菜单项里，交互职责更清晰。 */}
            <Button
              ref={profileTriggerRef}
              type="button"
              variant="ghost"
              size={"lg"}
              className="min-w-0 flex-1 justify-start gap-2 overflow-hidden rounded-tl-2xl rounded-bl-2xl border-0 pl-0"
              data-testid={
                stepCommunityActive ? TID_SIDEBAR_STEP_COMMUNITY_CHIP : TID_LOGIN_TRIGGER
              }
              aria-label={
                stepCommunityActive
                  ? `${communityDisplayName}，${stepCommunityConnected ? "已连接" : "未连接"}`
                  : profileBadge
              }
            >
              {/* Button 默认 shrink-0 且带 whitespace-nowrap，超长用户名会把 footer 撑出 sidebar。
                这里让触发按钮和文本列都允许收缩，并只在用户名自身做单行截断。 */}
              {profileContent}
            </Button>
          </DropdownMenuTrigger>
          {/* 菜单内容保持挂载，避免每次点击头像菜单都重建 footer 内部状态。*/}
          <DropdownMenuContent
            align="start"
            className={cn("w-max min-w-50", stepCommunityActive && "step-profile-menu")}
            collisionBoundary={stepCommunityActive ? profileMenuBounds?.element : undefined}
            collisionPadding={8}
            style={
              stepCommunityActive && profileMenuBounds
                ? ({ "--step-profile-menu-width": `${profileMenuBounds.width}px` } as CSSProperties)
                : undefined
            }
            forceMount
          >
            {/* 顶部摘要只呈现账户事实；把阅读区与下面的动作区分开，不将余额伪装成菜单项。 */}
            {showStepBalanceRow ? (
              <>
                <div
                  data-testid={TID_SIDEBAR_STEP_COMMUNITY_BALANCE}
                  className="step-profile-balance flex min-w-0 items-center gap-3 rounded-md bg-surface p-3 text-foreground"
                >
                  <span className="step-profile-balance-logo flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-foreground">
                    <StepCommunitySparkLogo className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <span className="block truncate text-ui-caption font-medium text-foreground-subtle">
                      {intl.formatMessage({ id: "sidebar.profile.stepCommunity.balance.label" })}
                    </span>
                    {stepBalanceRowStatus === "ready" ? (
                      <span
                        className="flex items-baseline gap-1 tabular-nums"
                        aria-label={intl.formatMessage(
                          { id: "sidebar.profile.stepCommunity.balance.amount" },
                          { amount: formatStepAmount(stepBalanceView.primary ?? 0) },
                        )}
                      >
                        <span
                          className="text-ui-base font-medium text-foreground-subtle"
                          aria-hidden="true"
                        >
                          ¥
                        </span>
                        <span
                          className="min-w-0 truncate text-ui-xl font-semibold tracking-tight"
                          data-testid="sidebar-step-community-balance-amount"
                        >
                          {formatStepAmount(stepBalanceView.primary ?? 0)}
                        </span>
                      </span>
                    ) : stepBalanceRowStatus === "login" ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="h-7 px-2.5 text-ui-sm"
                        onClick={openStepCommunitySettings}
                        data-testid="sidebar-step-community-balance-login"
                      >
                        {intl.formatMessage({ id: "sidebar.profile.stepCommunity.balance.login" })}
                      </Button>
                    ) : (
                      <span className="block min-h-7 text-ui-sm leading-7 text-foreground-subtle">
                        {intl.formatMessage({
                          id:
                            stepBalanceRowStatus === "error"
                              ? "sidebar.profile.stepCommunity.balance.error"
                              : stepBalanceRowStatus === "empty"
                                ? "sidebar.profile.stepCommunity.balance.empty"
                                : "sidebar.profile.stepCommunity.balance.loading",
                        })}
                      </span>
                    )}
                  </div>
                </div>
              </>
            ) : null}
            {stepCommunityActive && (
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                <User className="size-4" />
                修改用户名
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="size-4" />
                {intl.formatMessage({ id: "settings.locale" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={localeMenuValue} onValueChange={onLocaleChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({
                      id: "sidebar.settings.systemDefault",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="en-US">
                    {intl.formatMessage({
                      id: "sidebar.settings.locale.en-US",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zh-CN">
                    {intl.formatMessage({
                      id: "sidebar.settings.locale.zh-CN",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette className="size-4" />
                {intl.formatMessage({ id: "settings.themeMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({
                      id: "sidebar.settings.systemDefault",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-dark">
                    {intl.formatMessage({
                      id: "sidebar.settings.theme.zai-dark",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-light">
                    {intl.formatMessage({
                      id: "sidebar.settings.theme.zai-light",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <PencilRuler className="size-4" />
                {intl.formatMessage({ id: "settings.interfaceMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={interfaceMode}
                  onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
                >
                  <DropdownMenuRadioItem value="coding">
                    {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="office">
                    {intl.formatMessage({ id: "settings.interfaceMode.office" })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {/* 快捷键设置：缩放子菜单 label 读生效表，设置页改绑后即时跟随 */}
            {/* 收口重复缩放子菜单时误留了语言之后的那份，导致菜单顺序变成
                语言→缩放→主题；账户菜单分组顺序固定为 语言→主题→界面模式→缩放→用量→登录/登出，
                这里把唯一一份（读生效表）挪回用量摘要之前，不要再补第二份缩放子菜单。 */}
            {isDesktop ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ZoomIn className="size-4" />
                  {intl.formatMessage({ id: "sidebar.settings.interfaceZoom" })}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-50">
                  <DropdownMenuItem
                    disabled={!canZoomIn}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomIn)}
                  >
                    <ZoomIn className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomIn" })}
                    <DropdownMenuShortcut>{zoomInShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canZoomOut}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomOut)}
                  >
                    <ZoomOut className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomOut" })}
                    <DropdownMenuShortcut>{zoomOutShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canResetDesktopZoom}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ResetZoom)}
                  >
                    <Maximize className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.actualSize" })}
                    <DropdownMenuShortcut>{resetZoomShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {/* 社区版头像菜单只保留「使用统计」：套餐升级对本产品无意义，入口连同
                onUpgradeClick 契约一起移除。套餐升级仍存在于 composer / 会话配额提示，
                由各自的入口打开 CodingPlanUpgradeDialog，与此菜单无关。 */}
            <WorkspaceSidebarFooterUsageSummaryContent onUsageClick={usageButtonClick} />
            {/* 社区模式：OAuth 登录/登出走不通（WelcomeScreen 已抑制），auth 分区换成
                阶跃星辰密钥管理动词；身份信息已在 chip 与 aria-label，菜单只放动作。 */}
            {stepCommunityActive ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={openStepCommunitySettings}
                  data-testid={
                    stepCommunityConnected
                      ? TID_SIDEBAR_STEP_COMMUNITY_MENU_REPLACE_KEY
                      : TID_SIDEBAR_STEP_COMMUNITY_MENU_ENTER_KEY
                  }
                >
                  <KeyRound className="size-4" />
                  {intl.formatMessage({
                    id: stepCommunityConnected
                      ? "sidebar.profile.stepCommunity.menuReplaceKey"
                      : "sidebar.profile.stepCommunity.menuEnterKey",
                  })}
                </DropdownMenuItem>
                {stepCommunityConnected ? (
                  <DropdownMenuItem
                    onSelect={() => platform.openExternal(STEP_COMMUNITY_KEY_MANAGEMENT_URL)}
                    data-testid={TID_SIDEBAR_STEP_COMMUNITY_MENU_MANAGE_KEY}
                  >
                    <ExternalLink className="size-4" />
                    {intl.formatMessage({ id: "sidebar.profile.stepCommunity.menuManageKey" })}
                  </DropdownMenuItem>
                ) : null}
              </>
            ) : null}
            {onLogin && !user && !stepCommunityActive ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onLogin} data-testid={TID_LOGIN_MENU_ITEM}>
                  <LogInIcon className="size-4" />
                  {intl.formatMessage({ id: "app.login" })}
                </DropdownMenuItem>
              </>
            ) : null}
            {/* 社区模式但残留历史官方 OAuth 账号（user != null）时保留登出入口：
                否则用户在社区模式下永远无法退出旧账号。纯社区态（user 为 null）才抑制。 */}
            {onLogout && (!stepCommunityActive || user) ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onLogout} data-testid={TID_LOGOUT_BUTTON}>
                  <LogOut className="size-4" />
                  {intl.formatMessage({ id: "app.logout" })}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex shrink-0 items-center gap-1.5">
          <ControlHintTooltip title={settingsButtonLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-testid={TID_TASK_SETTINGS_BUTTON}
              aria-label={settingsButtonLabel}
              disabled={!onSettingsButtonClick}
              onClick={onSettingsButtonClick}
            >
              <Settings className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
      {stepCommunityActive && (
        <StepProfileNameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          name={communityDisplayName}
        />
      )}
    </footer>
  );
});
