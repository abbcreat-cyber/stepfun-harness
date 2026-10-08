import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, screen } from "electron";
import { join } from "node:path";
import {
  STEP_MINI_CHANNELS as channels,
  stepMiniSnapshotSchema,
  selectStepMiniActiveTasks,
  STEP_MINI_SCALE,
  stepMiniWindowSize,
  stepMiniWindowLayout,
  countStepMiniActiveTasks,
  type StepMiniSnapshot,
} from "@zcode/shared";
import { stepMiniContent } from "./stepMiniContent.js";

const miniWindows = new WeakSet<BrowserWindow>();
export const isStepMiniWindow = (window: BrowserWindow) => miniWindows.has(window);

/** Mini 仅缓存有界呈现快照并转发导航；任务事实仍由原 Host / renderer store 拥有。 */
export function registerStepMini(options: {
  openMain: () => Promise<unknown>;
  warn: (message: string) => void;
  iconPath: string;
}) {
  const feeds = new Map<number, { owner: BrowserWindow; snapshot: StepMiniSnapshot }>();
  let window: BrowserWindow | null = null;
  let expanded = false;
  let shown = false;
  let defaultOpened = false;
  let shortcut: string | null = null;
  let anchor: { right: number; bottom: number } | null = null;
  let layout: ReturnType<typeof stepMiniWindowLayout> | null = null;
  const background = process.env.STEPCODE_BACKGROUND === "1";

  function snapshot(): StepMiniSnapshot {
    const list = [...feeds.values()];
    const last = list.at(-1)?.snapshot;
    const tasks = new Map<string, StepMiniSnapshot["tasks"][number]>();
    for (const feed of list) for (const task of feed.snapshot.tasks) tasks.set(task.key, task);
    return {
      revision: last?.revision ?? 0,
      dark: last?.dark ?? true,
      locale: last?.locale ?? "zh-CN",
      fontSize: last?.fontSize ?? 14,
      tasks: selectStepMiniActiveTasks([...tasks.values()], 6),
      activeTaskCount: countStepMiniActiveTasks(list.map((feed) => feed.snapshot)),
    };
  }
  function resize() {
    if (!window || window.isDestroyed()) return;
    const previous = window.getBounds();
    const work = screen.getDisplayMatching(previous).workArea;
    anchor ??= { right: previous.x + previous.width, bottom: previous.y + previous.height };
    // 最后一张任务结束时先让 renderer 渐隐，再经 expand(false) 缩容器，避免裁掉动画。
    if (expanded && snapshot().tasks.length === 0) return;
    layout = stepMiniWindowLayout(anchor, expanded, snapshot().tasks.length, work);
    window.webContents.send(channels.layout, { direction: layout.direction });
    window.setBounds(layout.bounds);
  }
  function deliver() {
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channels.snapshot, snapshot());
    resize();
  }
  function ensureWindow() {
    if (window && !window.isDestroyed()) return window;
    const work = screen.getPrimaryDisplay().workArea;
    const size = stepMiniWindowSize(false, 0, work.height);
    window = new BrowserWindow({
      ...size,
      x: work.x + Math.round(work.width / 2) - Math.round(size.width / 2),
      y: work.y + work.height - size.height - 20,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      title: "Step Code Mini",
      icon: options.iconPath,
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/stepMini.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    miniWindows.add(window);
    const created = window;
    const initial = created.getBounds();
    anchor = { right: initial.x + initial.width, bottom: initial.y + initial.height };
    created.on("move", () => {
      const bounds = created.getBounds();
      // 原生 setBounds 也触发 move；仅用户拖动才更新控制条锚点。
      if (
        layout &&
        Object.entries(layout.bounds).every(
          ([key, value]) => bounds[key as keyof typeof bounds] === value,
        )
      )
        return;
      anchor = {
        right: bounds.x + bounds.width,
        bottom: bounds.y + (layout?.direction === "down" ? size.height : bounds.height),
      };
    });
    created.webContents.setZoomFactor(STEP_MINI_SCALE);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.on("closed", () => {
      if (window === created) {
        window = null;
        shown = false;
        expanded = false;
        anchor = null;
        layout = null;
      }
    });
    // Mini 使用 data 页面，CSP 只允许 data 图片；从默认图标生成同源缩略图，避免本地路径被拦截。
    const iconData = nativeImage
      .createFromPath(options.iconPath)
      .resize({ width: 32, height: 32 })
      .toDataURL();
    void created
      .loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(stepMiniContent.replace("__STEPCODE_APP_ICON__", iconData)),
      )
      .catch(() => options.warn("Mini 页面加载失败"));
    created.webContents.on("did-finish-load", () => {
      created.webContents.setZoomFactor(STEP_MINI_SCALE);
      deliver();
    });
    return created;
  }
  function toggle() {
    const target = ensureWindow();
    shown = !shown;
    if (shown) {
      if (!background) target.showInactive();
    } else target.hide();
    deliver();
    return { visible: shown, shortcut };
  }
  const fromMini = (senderId: number) =>
    Boolean(window && !window.isDestroyed() && window.webContents.id === senderId);

  ipcMain.handle(channels.publish, (event, input) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.webContents.id !== event.sender.id || isStepMiniWindow(owner))
      throw new Error("Mini 视图发送方无效");
    const parsed = stepMiniSnapshotSchema.parse(input);
    const previous = feeds.get(owner.id);
    if (
      previous &&
      previous.snapshot.generation === parsed.generation &&
      previous.snapshot.revision >= parsed.revision
    )
      return;
    if (!previous)
      owner.once("closed", () => {
        feeds.delete(owner.id);
        deliver();
      });
    feeds.set(owner.id, { owner, snapshot: parsed });
    if (!defaultOpened) {
      defaultOpened = true;
      toggle();
    }
    deliver();
  });
  ipcMain.handle(channels.toggle, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.webContents.id !== event.sender.id || isStepMiniWindow(owner))
      throw new Error("Mini 切换发送方无效");
    return toggle();
  });
  ipcMain.handle(channels.read, (event) => {
    if (!fromMini(event.sender.id)) throw new Error("Mini 发送方无效");
    return snapshot();
  });
  ipcMain.handle(channels.expand, (event, value) => {
    if (!fromMini(event.sender.id) || typeof value !== "boolean")
      throw new Error("Mini 展开发送方无效");
    expanded = value;
    resize();
    return { direction: layout?.direction ?? "up" };
  });
  ipcMain.handle(channels.hide, (event) => {
    if (!fromMini(event.sender.id)) throw new Error("Mini 发送方无效");
    shown = false;
    window?.hide();
  });
  ipcMain.handle(channels.action, async (event, input) => {
    if (!fromMini(event.sender.id)) throw new Error("Mini 操作发送方无效");
    let target: { owner: BrowserWindow; snapshot: StepMiniSnapshot } | undefined;
    let action;
    if (input?.type === "open-task" && typeof input.key === "string") {
      target = [...feeds.values()]
        .reverse()
        .find((feed) => feed.snapshot.tasks.some((task) => task.key === input.key));
      const task = target?.snapshot.tasks.find((task) => task.key === input.key);
      if (!task) {
        deliver();
        return false;
      }
      action = { type: "open-task", task };
    } else if (input?.type === "new-task") {
      target = [...feeds.values()].at(-1);
      action = { type: "new-task" };
    } else throw new Error("Mini 操作无效");
    if (!target || target.owner.isDestroyed()) {
      if (!background) await options.openMain();
      return false;
    }
    if (!background) {
      if (target.owner.isMinimized()) target.owner.restore();
      target.owner.show();
      target.owner.focus();
    }
    target.owner.webContents.send(channels.action, action);
    return true;
  });
  for (const candidate of [
    process.platform === "darwin" ? "Alt+Command+P" : "Alt+Super+P",
    "CommandOrControl+Alt+P",
  ]) {
    if (globalShortcut.register(candidate, toggle)) {
      shortcut = candidate;
      break;
    }
  }
  if (!shortcut) options.warn("Mini 快捷键被占用，可使用侧栏 Mini 按钮");
  app.once("will-quit", () => {
    if (shortcut) globalShortcut.unregister(shortcut);
    window?.destroy();
    feeds.clear();
  });
}
