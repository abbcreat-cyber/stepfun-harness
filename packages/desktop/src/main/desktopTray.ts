import { app, Menu, Tray } from "electron";
import { join } from "node:path";
import {
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  ZCODE_PRODUCT_FLAVOR,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import { buildDesktopTrayMenu } from "./desktopTrayModel.js";

let desktopTray: Tray | null = null;
let rebuildDesktopTrayContextMenu: (() => void) | null = null;

function resolveDesktopTrayIconPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "tray_icon.ico")
    : join(import.meta.dirname, "../../build/icon.ico");
}

export function createWindowsDesktopTray(options: {
  getLocale: () => Locale;
  showCurrentWindow: () => Promise<void> | void;
  executeDesktopCommand: (command: DesktopCommandId) => Promise<unknown>;
  quitApp: () => void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  if (process.platform !== "win32") {
    return null;
  }

  if (desktopTray) {
    return desktopTray;
  }

  try {
    desktopTray = new Tray(resolveDesktopTrayIconPath());
  } catch (error) {
    options.logger.warn("[desktop-tray] failed to create tray icon", error);
    return null;
  }

  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuMessage(options.getLocale(), id);
  const showTrayWindow = () => {
    void Promise.resolve(options.showCurrentWindow()).catch((error) => {
      options.logger.warn("[desktop-tray] failed to show current window", error);
    });
  };
  const executeTrayCommand = (command: DesktopCommandId) => {
    // 后台验收沿同一托盘命令链，但不等待需要显示/聚焦窗口的 reveal 流程。
    void Promise.resolve(process.env.STEPCODE_BACKGROUND === "1" ? undefined : options.showCurrentWindow())
      .then(() => options.executeDesktopCommand(command))
      .catch((error) => {
        options.logger.warn(`[desktop-tray] failed to execute tray command ${command}`, error);
      });
  };
  const rebuildContextMenu = () => {
    desktopTray?.setToolTip(process.env.STEP_BACKEND === "stepcode-local" ? "Step Code" : getLabel(desktopMenuMessageIds.trayTooltip));
    desktopTray?.setContextMenu(
      Menu.buildFromTemplate(buildDesktopTrayMenu({
        getLabel,
        // Step 模式只更新底座，不受上游外壳 Preview 更新限制。
        updatesEnabled: process.env.STEP_BACKEND === "stepcode-local" || ZCODE_PRODUCT_FLAVOR === "production",
        showWindow: showTrayWindow,
        execute: executeTrayCommand,
        quit: options.quitApp,
      })),
    );
  };

  rebuildDesktopTrayContextMenu = rebuildContextMenu;
  desktopTray.on("click", showTrayWindow);
  desktopTray.on("double-click", showTrayWindow);
  rebuildContextMenu();

  return desktopTray;
}

export function updateWindowsDesktopTrayMenu() {
  rebuildDesktopTrayContextMenu?.();
}
