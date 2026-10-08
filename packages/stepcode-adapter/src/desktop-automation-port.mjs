const CREATE_KEYS = new Set(["cron", "prompt", "title", "recurring", "durable"]);

function assertParams(params, keys) {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).some((key) => !keys.has(key))
  )
    throw new Error("Invalid desktop automation parameters");
}

function toolDenied(context, tool) {
  const canonical = { cron_create: "CronCreate", cron_delete: "CronDelete", cron_list: "CronList" }[
    tool
  ];
  return (
    (context.toolAllowlist !== undefined &&
      !context.toolAllowlist.some((name) => name === tool || name === canonical)) ||
    context.toolDisallowlist?.some((name) => name === tool || name === canonical)
  );
}

function forbidden(context, tool) {
  return context.activeAutomationId || toolDenied(context, tool);
}

/** 不持有任务状态；所有写入仍由已有 Host AutomationService 完成。 */
export function createDesktopAutomationPort(requestHost) {
  let mutations = Promise.resolve();
  async function execute(command, getLiveContext) {
    const context = getLiveContext();
    if (!context?.sessionId || !context.turnId)
      throw new Error("Desktop automation requires an active session turn");
    const live = () => {
      const current = getLiveContext();
      if (!current || current.sessionId !== context.sessionId || current.turnId !== context.turnId)
        throw new Error("Desktop automation request is stale");
      return current;
    };
    const params = command.params ?? {};
    if (command.method === "list") {
      assertParams(params, new Set());
      if (toolDenied(live(), "cron_list")) throw new Error("Scheduled task listing is disallowed");
      return requestHost("automation/list", {});
    }
    if (command.method === "delete") {
      assertParams(params, new Set(["id"]));
      if (forbidden(live(), "cron_delete"))
        throw new Error("Cannot delete a scheduled task while running a scheduled task");
      if (typeof params.id !== "string" || !params.id.trim())
        throw new Error("Task id is required");
      // Host delete 也按自身 workspace 校验；先读 scoped list，让未知/外域 ID 在桥接边界拒绝。
      const result = await requestHost("automation/list", {});
      if (!Array.isArray(result?.automations))
        throw new Error("Invalid desktop automation list result");
      if (!result.automations.some((item) => item.automationId === params.id))
        return { deleted: false };
      if (forbidden(live(), "cron_delete"))
        throw new Error("Scheduled task deletion is disallowed");
      const deleted = await requestHost("automation/delete", { automationId: params.id });
      if (typeof deleted?.deleted !== "boolean")
        throw new Error("Invalid desktop automation delete result");
      return deleted;
    }
    if (command.method !== "create") throw new Error("Unsupported desktop automation operation");
    assertParams(params, CREATE_KEYS);
    if (
      typeof params.cron !== "string" ||
      !params.cron.trim() ||
      typeof params.prompt !== "string" ||
      !params.prompt.trim() ||
      (params.title !== undefined && typeof params.title !== "string") ||
      ["recurring", "durable"].some(
        (key) => params[key] !== undefined && typeof params[key] !== "boolean",
      )
    )
      throw new Error("Invalid desktop automation create parameters");
    if (forbidden(live(), "cron_create"))
      throw new Error("Cannot create a scheduled task while running a scheduled task");
    const binding = await requestHost("automation/checkTaskBinding", {
      targetTaskId: context.sessionId,
    });
    if (typeof binding?.bound !== "boolean")
      throw new Error("Cannot verify scheduled task binding");
    if (binding.bound)
      throw new Error("This session already belongs to a scheduled task; start a new chat");
    const current = live();
    if (forbidden(current, "cron_create")) throw new Error("Scheduled task creation is disallowed");
    if (!current.modelSelection?.providerId || !current.modelSelection.modelId || !current.mode)
      throw new Error("Current model selection and permission mode are unavailable");
    const result = await requestHost("automation/create", {
      cronExpr: params.cron.trim(),
      prompt: params.prompt.trim(),
      title: params.title ?? "",
      recurring: params.recurring ?? true,
      targetTaskId: current.sessionId,
      modelSelection: structuredClone(current.modelSelection),
      mode: current.mode,
      ...(current.botDeliveryTarget ? { botDeliveryTarget: current.botDeliveryTarget } : {}),
    });
    if (
      typeof result?.automation?.automationId !== "string" ||
      !result.automation.automationId.trim()
    )
      throw new Error(
        "Desktop automation persistence did not return a task id; do not retry automatically",
      );
    return result;
  }
  return (command, getLiveContext) => {
    if (command.method === "list") return execute(command, getLiveContext);
    // 并行工具调用的绑定检查与创建必须串行；第二个调用查询第一条已提交记录。
    const result = mutations.then(() => execute(command, getLiveContext));
    mutations = result.catch(() => {});
    return result;
  };
}
