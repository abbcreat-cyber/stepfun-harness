import { win32 } from "node:path";
import type { AppDetailsOptions } from "electron";

/** 任务栏读取 RelaunchIconResource；仅 setIcon 不能覆盖 Shell 的应用组旧图标。 */
export function buildDesktopTaskbarDetails(input: {
  appId: string;
  iconPath: string;
  executablePath: string;
  launcherPath?: string;
  systemRoot?: string;
}): AppDetailsOptions {
  const command = input.launcherPath
    ? `"${win32.join(input.systemRoot || "C:/Windows", "System32", "wscript.exe")}" "${input.launcherPath}"`
    : `"${input.executablePath}"`;
  return {
    appId: input.appId,
    appIconPath: input.iconPath,
    appIconIndex: 0,
    relaunchCommand: command,
    relaunchDisplayName: "Step Code",
  };
}
