import { isUnboundedContextRuleGoal } from "../desktop-task-contracts.mjs";
import { desktopPluginReferenceContext, isBarePluginRequest } from "../desktop-plugin-context.mjs";
import { withCommunicationPolicy } from "../assistant-communication.mjs";
import { registerAssistantOpeningHook } from "../assistant-opening-hook.mjs";
import { readBuiltinHooks, FIRST_PRINCIPLES_REMINDER } from "../builtin-hooks.mjs";
import { orderRuntimeNotices, withDesktopInputOrigin } from "../runtime-notice-context.mjs";

/** 给模型真实产品工具边界，并在执行前阻止把常驻规则变成烧迭代的工作目标。 */
export default function desktopTaskContracts(pi) {
  if (process.env.STEPCODE_TASK_MODE !== "desktop") return;
  let loadedSkills = [], pluginDiscoveryContext = "";
  let hookSettings = {}, hookSettingsError = "";
  let needsPluginTarget = false;
  let rejectedTargetSearches = 0;
  pi.on("context", event => {
    const latest = pluginDiscoveryContext ? event.messages.findLast(message => message.customType === "desktop-selected-plugin") : undefined;
    return { messages: orderRuntimeNotices(event.messages.filter(message => message.customType !== "desktop-selected-plugin" || message === latest)) };
  });
  pi.on("tool_result", event => {
    if (event.toolName !== "find_tools" || !pluginDiscoveryContext) return;
    // 工具索引不包含技能正文；保留真实搜索结果，同时提供本轮点选插件的能力入口。
    return { content: [...(event.content ?? []), { type: "text", text: pluginDiscoveryContext }] };
  });
  pi.on("tool_call", async (event) => {
    if (hookSettingsError) return { block: true, terminate: true, reason: hookSettingsError };
    if (needsPluginTarget && ["find_files", "search_files", "list_directory", "run_command"].includes(event.toolName)) {
      rejectedTargetSearches++;
      return { block: true, ...(rejectedTargetSearches > 1 ? { terminate: true } : {}), reason: "用户点选的是插件能力，没有提供文件附件或具体任务。不要猜测文件或扫描磁盘；请简短说明该插件用途，并询问要处理哪个文件或制作什么内容。" };
    }
    if (/browser_(?:navigate|new_tab)$/.test(event.toolName ?? "") && /^plugin:\/\//i.test(event.input?.url ?? "")) {
      const facts = await desktopPluginReferenceContext(event.input.url, loadedSkills, process.env.STEPCODE_STORAGE_ROOT_DIR);
      return { block: true, reason: "plugin:// 是应用插件引用，不能作为网页地址导航。" + facts };
    }
    // 原生 run_command 省略期限会无限等待；递归搜索可拖住同批工具和整轮。
    // 只补参数，权限、超时清理与结束事件仍由 SDK 的原执行器负责。
    if (
      event.toolName === "run_command" &&
      event.input &&
      event.input.run_in_background !== true &&
      event.input.timeout_ms === undefined
    )
      event.input.timeout_ms = 60000;
    if (event.toolName === "create_goal" && isUnboundedContextRuleGoal(event.input?.objective))
      return {
        block: true,
        reason:
          "常驻规则和每轮钩子是上下文约束，不能创建永不完成的自主 goal。请安装并验证实际规则扩展；不要自动续跑或反复调用模型验证。",
      };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    hookSettingsError = "";
    try { hookSettings = await readBuiltinHooks(process.env.STEPCODE_STORAGE_ROOT_DIR); }
    catch (error) { hookSettings = {}; hookSettingsError = `[desktop-hooks-stopped] 内置钩子配置读取失败，本轮工具已停止：${error.message}`; }
    loadedSkills = event.systemPromptOptions?.skills ?? [];
    pluginDiscoveryContext = "";
    pluginDiscoveryContext = await desktopPluginReferenceContext(event.prompt, loadedSkills, process.env.STEPCODE_STORAGE_ROOT_DIR);
    needsPluginTarget = !!pluginDiscoveryContext && isBarePluginRequest(event.prompt, event.images);
    rejectedTargetSearches = 0;
    const activated = await desktopPluginReferenceContext(event.prompt, loadedSkills, process.env.STEPCODE_STORAGE_ROOT_DIR, { activateSkills: true });
    return ({
    // 用 SDK 原生每轮上下文消息传能力事实；部分兼容端点不保留 developer 系统消息。
    ...(activated ? { message: { customType: "desktop-selected-plugin", display: false,
      content: `当前工作区：${ctx?.cwd ?? process.cwd()}。plugin:// 只选择插件，不是文件附件。${activated}` } } : {}),
    systemPrompt:
      withDesktopInputOrigin(withCommunicationPolicy(event.systemPrompt)) +
      (hookSettings["first-principles"] ? FIRST_PRINCIPLES_REMINDER : "") +
      (hookSettingsError ? `\n${hookSettingsError}` : "") +
      "\n\n桌面工具：定时任务使用当前 cron 工具。run_command 前台命令省略 timeout_ms 时为 60000 毫秒，长任务显式设置期限，长期服务使用 run_in_background。文件查找优先专用搜索工具；不为普通问答核查插件或规则的安装。" +
      `\n当前实际工作区：${ctx?.cwd ?? process.cwd()}。路径以工具回执和当前工作区为准，不猜测其他项目路径。`,
    });
  });
  registerAssistantOpeningHook(pi, () => hookSettings["opening-explanation"] !== false);
}
