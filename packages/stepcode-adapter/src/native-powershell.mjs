/** 原生工具本来已注册，仅默认 Step 活动工具集遗漏了 PowerShell；不自建执行器。 */
export function activateNativePowerShell(pi, platform = process.platform) {
  if (platform !== "win32" || typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return false;
  const active = pi.getActiveTools();
  if (!active.includes("run_command") || !pi.getAllTools().some(tool => tool.name === "powershell")) return false;
  if (!active.includes("powershell")) pi.setActiveTools([...active, "powershell"]);
  return true;
}

export function unsafePowerShellNesting(command) {
  if (typeof command !== "string" || !/^\s*(?:powershell|pwsh)(?:\.exe)?\s/i.test(command)) return false;
  // Bash 先展开双引号内的变量；这里仅拒绝已知错误写法，不猜测或重写用户脚本。
  const body = /\s-(?:Command|c)\s+"([^"\n]*)/i.exec(command)?.[1];
  return Boolean((body && /(?<!\\)\$/.test(body)) || /\s-File\s+[A-Za-z]:\\/i.test(command));
}

export function nativePowerShellContract(pi) {
  let available = false;
  const activate = () => { available = activateNativePowerShell(pi); };
  pi.on("session_start", activate);
  pi.on("before_agent_start", activate);
  pi.on("tool_call", event => {
    if (process.platform !== "win32") return;
    if (event.toolName === "powershell" && event.input && event.input.timeout === undefined) event.input.timeout = 60;
    if (available && event.toolName === "run_command" && unsafePowerShellNesting(event.input?.command)) return {
      block: true,
      reason: "命令尚未执行：Git Bash 会先解释这条 PowerShell 命令里的变量或反斜杠。请改用 powershell 工具，command 直接填写原始 PowerShell 脚本，不要套 powershell -Command；timeout 单位为秒。不要重复执行已成功的其他命令。",
    };
  });
}
