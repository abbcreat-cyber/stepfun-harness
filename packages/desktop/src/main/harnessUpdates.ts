import { CancellationToken, type AppUpdater, type UpdateInfo } from "electron-updater";
import type { HarnessUpdateSnapshot, HarnessUpdateTarget, HarnessUpdateRequest, UpdateStatePayload } from "@zcode/shared";

export const HARNESS_UPDATE_FEED = { provider: "github" as const, owner: "abbcreat-cyber", repo: "stepfun-harness", releaseType: "release" as const };

/** Main owns the bundled application update. The runtime ships with the tested release. */
export class HarnessUpdates {
  private state: HarnessUpdateSnapshot;
  private pending = new Map<HarnessUpdateTarget, Promise<void>>();
  private cancellation: CancellationToken | null = null;
  private installing = false;
  private downloadIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private downloadTimedOut = false;
  private lastProgressBytes = -1;
  private availableDesktop: UpdateInfo | undefined;
  private autoInstallRequested = false;
  private installTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly desktop: AppUpdater, version: string,
    private readonly install: (target: HarnessUpdateTarget) => Promise<void>,
    private readonly publish: (state: UpdateStatePayload) => void,
    private readonly options: { downloadIdleTimeoutMs?: number; prepareDesktop?: (info: UpdateInfo) => Promise<void>; usePreparedDesktop?: () => () => void; getRunningTaskCount?: () => number; taskPollMs?: number } = {},
  ) {
    this.state = {
      desktop: { currentVersion: version, state: { kind: "idle", enabled: true }, checked: false },
    };
    desktop.autoDownload = false; desktop.autoInstallOnAppQuit = false;
    desktop.allowPrerelease = false; desktop.allowDowngrade = false;
    desktop.setFeedURL(HARNESS_UPDATE_FEED);
    const notes = (info: UpdateInfo) => ({ version: info.version, title: `StepFun Harness ${info.version}`,
      markdown: typeof info.releaseNotes === "string" ? info.releaseNotes : (info.releaseNotes ?? []).map(n => n.note).join("\n") });
    desktop.on("checking-for-update", () => { this.availableDesktop = undefined; this.set("desktop", { kind: "checking", enabled: false }); });
    desktop.on("update-available", info => { this.availableDesktop = info; });
    desktop.on("update-not-available", () => this.set("desktop", { kind: "idle", enabled: true }));
    desktop.on("download-progress", p => {
      // 取消请求收尾前可能仍收到数据；旧事件不能把窗口重新推回下载中。
      if (!this.cancellation || this.cancellation.cancelled) return;
      if (p.transferred !== this.lastProgressBytes) { this.lastProgressBytes = p.transferred; this.armDownloadDeadline(); }
      this.set("desktop", { ...this.state.desktop.state, kind: "download-progress", enabled: true,
        downloadPhase: p.percent >= 100 ? "verifying" : "transferring",
        progress: String(Math.round(p.percent * 10) / 10), transferredBytes: p.transferred, totalBytes: p.total, bytesPerSecond: p.bytesPerSecond });
    });
    desktop.on("update-downloaded", info => {
      if (!this.cancellation || this.cancellation.cancelled) return;
      clearTimeout(this.downloadIdleTimer);
      this.set("desktop", { kind: "update-downloaded", enabled: true, version: info.version, releaseNotes: notes(info) });
    });
    // EventEmitter error must have a listener; the command's promise records the failure.
    desktop.on("error", error => {
      this.state.desktop.error = error.message;
      if (this.installing) { this.installing = false; this.clearInstallIntent(); }
    });
  }
  private clearInstallIntent() {
    this.autoInstallRequested = false;
    clearTimeout(this.installTimer);
    this.installTimer = undefined;
    delete this.state.desktop.installPhase;
    delete this.state.desktop.activeTasks;
  }
  private async advanceInstall() {
    if (!this.autoInstallRequested || this.installing || this.state.desktop.state.kind !== "update-downloaded") return;
    clearTimeout(this.installTimer);
    try {
      const count = this.options.getRunningTaskCount?.() ?? Number.NaN;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("HARNESS_TASK_STATUS_UNAVAILABLE");
      if (count > 0) {
        this.state.desktop.installPhase = "waiting-for-tasks";
        this.state.desktop.activeTasks = count;
        this.installTimer = setTimeout(() => { void this.advanceInstall(); }, this.options.taskPollMs ?? 1000);
        this.installTimer.unref?.();
        return;
      }
      this.installing = true;
      this.state.desktop.installPhase = "installing";
      delete this.state.desktop.activeTasks;
      // 下载成功后只由 Main 推进安装，面板关闭或多窗口重复点击都不会产生第二次安装。
      await this.install("desktop");
    } catch (error) {
      this.installing = false;
      if (error instanceof Error && error.message === "HARNESS_TASKS_RUNNING") {
        this.state.desktop.installPhase = "waiting-for-tasks";
        this.installTimer = setTimeout(() => { void this.advanceInstall(); }, this.options.taskPollMs ?? 1000);
        this.installTimer.unref?.();
        return;
      }
      this.clearInstallIntent();
      this.state.desktop.error = error instanceof Error ? error.message : String(error);
    }
  }
  snapshot(): HarnessUpdateSnapshot { return structuredClone(this.state); }
  async prepareToShow() {
    if (["download-progress", "update-downloaded"].includes(this.state.desktop.state.kind)) return;
    await this.command({ action: "check" });
    await Promise.all([...this.pending.values()]);
    if (this.state.desktop.error) throw new Error(this.state.desktop.error);
  }
  private armDownloadDeadline() {
    clearTimeout(this.downloadIdleTimer);
    this.downloadIdleTimer = setTimeout(() => {
      this.downloadTimedOut = true;
      this.cancellation?.cancel();
    }, this.options.downloadIdleTimeoutMs ?? 90000);
    this.downloadIdleTimer.unref?.();
  }
  private set(target: HarnessUpdateTarget, state: UpdateStatePayload) {
    this.state[target].state = state;
    const entries = [this.state.desktop.state];
    const selected = entries.find(s => s.kind === "update-downloaded") ?? entries.find(s => s.kind === "download-progress") ?? entries.find(s => s.kind === "update-available") ?? { kind: "idle" as const, enabled: true };
    this.publish(selected);
  }
  private run(target: HarnessUpdateTarget, action: "check" | "download") {
    if (this.pending.has(target)) return;
    const item = this.state[target], prior = item.state;
    if (action === "check" && ["download-progress", "update-downloaded"].includes(prior.kind)) return;
    if (action === "download" && prior.kind !== "update-available") throw new Error("No verified update is available");
    if (action === "download") { this.clearInstallIntent(); this.autoInstallRequested = true; }
    delete item.error;
    this.set(target, action === "check" ? { kind: "checking", enabled: false } : { ...prior, kind: "download-progress", enabled: true, progress: "", downloadPhase: "preparing" });
    const operation = (async () => {
      try {
        if (action === "check") {
          await this.desktop.checkForUpdates();
          const info = this.availableDesktop;
          if (info) {
            await this.options.prepareDesktop?.(info);
            this.set("desktop", { kind: "update-available", enabled: true, version: info.version,
              releaseNotes: { version: info.version, title: `StepFun Harness ${info.version}`, markdown: typeof info.releaseNotes === "string" ? info.releaseNotes : (info.releaseNotes ?? []).map(note => note.note).join("\n") } });
          }
        }
        else {
          this.cancellation = new CancellationToken(); this.downloadTimedOut = false; this.lastProgressBytes = -1;
          this.armDownloadDeadline();
          const restore = this.options.usePreparedDesktop?.();
          try { await this.desktop.downloadUpdate(this.cancellation); }
          finally { restore?.(); }
        }
        if (action === "check") item.checked = true;
      } catch (error) {
        if (action === "download") this.clearInstallIntent();
        const cancelled = target === "desktop" && this.cancellation?.cancelled;
        item.error = target === "desktop" && action === "download" && this.downloadTimedOut
          ? "HARNESS_DOWNLOAD_STALLED" : cancelled ? undefined : error instanceof Error ? error.message : String(error);
        this.set(target, action === "download" ? prior : { kind: "idle", enabled: true });
      } finally { this.pending.delete(target); if (target === "desktop") { clearTimeout(this.downloadIdleTimer); this.cancellation = null; } }
      // downloaded 事件可能早于 downloadUpdate promise 收尾；校验/传输最终失败绝不能启动安装。
      if (action === "download") void this.advanceInstall();
    })();
    this.pending.set(target, operation);
  }
  async command(request: HarnessUpdateRequest): Promise<HarnessUpdateSnapshot> {
    if (!request || !["snapshot", "check", "download", "cancel", "install"].includes(request.action)) throw new Error("Invalid update action");
    const { action, target } = request;
    // 旧窗口/旧 IPC 请求也不能绕过整包更新策略启动底座更新。
    if (target !== undefined && target !== "desktop") throw new Error("Invalid update target");
    if (action === "snapshot") return this.snapshot();
    if (action === "check" && target === undefined) { this.run("desktop", "check"); return this.snapshot(); }
    if (target !== "desktop") throw new Error("Invalid update target");
    if (action === "check" || action === "download") this.run(target, action);
    if (action === "cancel") {
      if (this.installing) throw new Error("Installation is already in progress");
      this.clearInstallIntent();
      if (target === "desktop" && this.cancellation) {
        clearTimeout(this.downloadIdleTimer);
        const state = this.state.desktop.state;
        if (state.kind === "download-progress") this.set("desktop", { ...state, downloadPhase: "cancelling" });
        this.cancellation.cancel();
      }
    }
    if (action === "install") {
      if (this.installing || this.autoInstallRequested) return this.snapshot();
      if (this.state[target].state.kind !== "update-downloaded") throw new Error("Update is not ready to install");
      delete this.state.desktop.error;
      this.autoInstallRequested = true;
      void this.advanceInstall();
    }
    return this.snapshot();
  }
}
