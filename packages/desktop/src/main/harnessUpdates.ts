import { CancellationToken, type AppUpdater, type UpdateInfo } from "electron-updater";
import type { HarnessUpdateSnapshot, HarnessUpdateTarget, HarnessUpdateRequest, UpdateStatePayload } from "@zcode/shared";
import { StepcodeRuntimeUpdater } from "./stepcodeRuntimeUpdater.js";

export const HARNESS_UPDATE_FEED = { provider: "github" as const, owner: "abbcreat-cyber", repo: "stepfun-harness", releaseType: "release" as const };

/** Main owns both update channels. Renderer only receives snapshots and sends commands. */
export class HarnessUpdates {
  readonly step: StepcodeRuntimeUpdater;
  private state: HarnessUpdateSnapshot;
  private pending = new Map<HarnessUpdateTarget, Promise<void>>();
  private cancellation: CancellationToken | null = null;
  private installing = false;
  constructor(private readonly desktop: AppUpdater, versions: { desktop: string; step: string }, runtimeRoot: string,
    private readonly install: (target: HarnessUpdateTarget) => Promise<void>,
    private readonly publish: (state: UpdateStatePayload) => void,
  ) {
    this.state = {
      desktop: { currentVersion: versions.desktop, state: { kind: "idle", enabled: true }, checked: false },
      step: { currentVersion: versions.step, state: { kind: "idle", enabled: true }, checked: false },
    };
    this.step = new StepcodeRuntimeUpdater(runtimeRoot, versions.step, s => this.set("step", s), () => {});
    desktop.autoDownload = false; desktop.autoInstallOnAppQuit = false;
    desktop.allowPrerelease = false; desktop.allowDowngrade = false;
    desktop.setFeedURL(HARNESS_UPDATE_FEED);
    const notes = (info: UpdateInfo) => ({ version: info.version, title: `StepFun Harness ${info.version}`,
      markdown: typeof info.releaseNotes === "string" ? info.releaseNotes : (info.releaseNotes ?? []).map(n => n.note).join("\n") });
    desktop.on("checking-for-update", () => this.set("desktop", { kind: "checking", enabled: false }));
    desktop.on("update-available", info => this.set("desktop", { kind: "update-available", enabled: true, version: info.version, releaseNotes: notes(info) }));
    desktop.on("update-not-available", () => this.set("desktop", { kind: "idle", enabled: true }));
    desktop.on("download-progress", p => this.set("desktop", { ...this.state.desktop.state, kind: "download-progress", enabled: true,
      progress: String(Math.floor(p.percent)), transferredBytes: p.transferred, totalBytes: p.total }));
    desktop.on("update-downloaded", info => this.set("desktop", { kind: "update-downloaded", enabled: true, version: info.version, releaseNotes: notes(info) }));
    // EventEmitter error must have a listener; the command's promise records the failure.
    desktop.on("error", error => { this.state.desktop.error = error.message; });
  }
  snapshot(): HarnessUpdateSnapshot { return structuredClone(this.state); }
  private set(target: HarnessUpdateTarget, state: UpdateStatePayload) {
    this.state[target].state = state;
    const entries = [this.state.desktop.state, this.state.step.state];
    const selected = entries.find(s => s.kind === "update-downloaded") ?? entries.find(s => s.kind === "download-progress") ?? entries.find(s => s.kind === "update-available") ?? { kind: "idle" as const, enabled: true };
    this.publish(selected);
  }
  private run(target: HarnessUpdateTarget, action: "check" | "download") {
    if (this.pending.has(target)) return;
    const item = this.state[target], prior = item.state;
    if (action === "check" && ["download-progress", "update-downloaded"].includes(prior.kind)) return;
    if (action === "download" && prior.kind !== "update-available") throw new Error("No verified update is available");
    delete item.error;
    this.set(target, action === "check" ? { kind: "checking", enabled: false } : { ...prior, kind: "download-progress", enabled: true, progress: "0" });
    const operation = (async () => {
      try {
        if (target === "step") {
          if (action === "check") await this.step.check({ manual: true }); else await this.step.download();
        } else if (action === "check") await this.desktop.checkForUpdates();
        else { this.cancellation = new CancellationToken(); await this.desktop.downloadUpdate(this.cancellation); }
        if (action === "check") item.checked = true;
      } catch (error) {
        const cancelled = target === "desktop" && this.cancellation?.cancelled;
        item.error = cancelled ? undefined : error instanceof Error ? error.message : String(error);
        this.set(target, action === "download" ? prior : { kind: "idle", enabled: true });
      } finally { this.pending.delete(target); if (target === "desktop") this.cancellation = null; }
    })();
    this.pending.set(target, operation);
  }
  async command(request: HarnessUpdateRequest): Promise<HarnessUpdateSnapshot> {
    if (!request || !["snapshot", "check", "download", "cancel", "install"].includes(request.action)) throw new Error("Invalid update action");
    const { action, target } = request;
    if (action === "snapshot") return this.snapshot();
    if (action === "check" && target === undefined) { this.run("desktop", "check"); this.run("step", "check"); return this.snapshot(); }
    if (target !== "desktop" && target !== "step") throw new Error("Invalid update target");
    if (action === "check" || action === "download") this.run(target, action);
    if (action === "cancel") { if (target === "desktop") this.cancellation?.cancel(); else this.step.cancel(); }
    if (action === "install") {
      if (this.installing) throw new Error("Installation is already in progress");
      if (this.state[target].state.kind !== "update-downloaded") throw new Error("Update is not ready to install");
      this.installing = true;
      try { if (target === "step") await this.step.activate(); await this.install(target); }
      finally { this.installing = false; }
    }
    return this.snapshot();
  }
}
