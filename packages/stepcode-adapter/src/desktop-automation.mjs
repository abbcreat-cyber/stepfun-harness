import { fileURLToPath } from "node:url";

export const DESKTOP_AUTOMATION_COMMAND = "stepcode-desktop-automation-v1";
export const DESKTOP_AUTOMATION_DESCRIPTION = "Desktop persistent automation tools v1";

export function desktopAutomationEnvironment(env) {
  // 桌面工具必须只有 Host 调度器拥有执行权；关闭原生 cron 的注册、加载与计时。
  return { ...env, STEPCODE_TASK_MODE: "desktop", STEP_DISABLE_CRON: "1" };
}

export function withDesktopAutomation(command, options = {}) {
  if (options.env?.STEPCODE_TASK_MODE !== "desktop") return command;
  if (options.env?.STEP_DISABLE_CRON !== "1")
    throw new Error("Desktop automation requires native cron to be disabled");
  const extension = fileURLToPath(new URL("./extensions/desktop-automation.mjs", import.meta.url));
  return command.includes(extension) ? command : [...command, "--extension", extension];
}

export async function assertDesktopAutomationLoaded(client) {
  if (client.options.env?.STEPCODE_TASK_MODE !== "desktop") return;
  const commands = await client.getCommands();
  if (
    !commands.some(
      (item) =>
        item.name === DESKTOP_AUTOMATION_COMMAND &&
        item.description === DESKTOP_AUTOMATION_DESCRIPTION &&
        item.source === "extension",
    )
  )
    throw new Error("Desktop automation extension failed to initialize; request is blocked");
}
