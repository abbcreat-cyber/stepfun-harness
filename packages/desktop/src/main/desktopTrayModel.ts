import type { MenuItemConstructorOptions } from "electron";
import { DesktopCommandIds, desktopMenuMessageIds, type DesktopCommandId } from "@zcode/shared";

/** 托盘只提供常用操作；不暴露关于弹窗或清除数据入口。 */
export function buildDesktopTrayMenu(options: {
  getLabel: (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) => string;
  updatesEnabled: boolean;
  showWindow: () => void;
  execute: (command: DesktopCommandId) => void;
  quit: () => void;
}): MenuItemConstructorOptions[] {
  const { getLabel, execute } = options;
  return [
    { label: getLabel(desktopMenuMessageIds.trayOpenZCode), click: options.showWindow },
    { type: "separator" },
    { label: getLabel(desktopMenuMessageIds.fileNewTask), click: () => execute(DesktopCommandIds.NewTask) },
    { label: getLabel(desktopMenuMessageIds.fileOpenWorkspace), click: () => execute(DesktopCommandIds.OpenWorkspace) },
    ...(options.updatesEnabled ? [
      { type: "separator" as const },
      { label: getLabel(desktopMenuMessageIds.helpCheckForUpdates), click: () => execute(DesktopCommandIds.CheckForUpdates) },
    ] : []),
    { type: "separator" },
    { label: getLabel(desktopMenuMessageIds.trayQuit), click: options.quit },
  ];
}
