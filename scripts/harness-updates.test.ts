import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AppUpdater, CancellationToken } from "electron-updater";
import { HarnessUpdates, HARNESS_UPDATE_FEED } from "../packages/desktop/src/main/harnessUpdates.js";
import { HarnessPreparedDownload } from "../packages/desktop/src/main/harnessPreparedDownload.js";
import { gzipSync } from "node:zlib";
import { CancellationToken as DownloadCancellationToken } from "electron-updater";

class FakeUpdater extends EventEmitter {
  feed: unknown; checks = 0; downloads = 0;
  finishCheck = () => {}; finishDownload = () => {};
  setFeedURL(feed: unknown) { this.feed = feed; }
  checkForUpdates() {
    this.checks++; this.emit("checking-for-update");
    return new Promise<void>(resolve => { this.finishCheck = () => { this.emit("update-available", { version: "0.2.0", releaseNotes: "Fixture release" }); resolve(); }; });
  }
  downloadUpdate(token: CancellationToken) {
    this.downloads++;
    return new Promise<void>((resolve, reject) => {
      token.onCancel(() => reject(new Error("cancelled")));
      this.finishDownload = () => { this.emit("update-downloaded", { version: "0.2.0" }); resolve(); };
    });
  }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test("own release feed, one operation per channel, cancelled download can retry, install only when ready", async () => {
  const fake = new FakeUpdater(); const installed: string[] = [];
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, { desktop: "0.1.0", step: "0.1.2" }, "D:/Temp/harness-updater-test", async target => { installed.push(target); }, () => {});
  assert.deepEqual(fake.feed, HARNESS_UPDATE_FEED);
  await assert.rejects(updates.command({ action: "install", target: "desktop" }), /not ready/);
  await updates.command({ action: "check", target: "desktop" }); await updates.command({ action: "check", target: "desktop" });
  assert.equal(fake.checks, 1); fake.finishCheck(); await settle();
  assert.equal(updates.snapshot().desktop.state.kind, "update-available");
  await updates.command({ action: "download", target: "desktop" });
  await updates.command({ action: "check", target: "desktop" }); assert.equal(fake.checks, 1);
  await updates.command({ action: "cancel", target: "desktop" }); await settle();
  assert.equal(updates.snapshot().desktop.state.kind, "update-available"); assert.equal(updates.snapshot().desktop.error, undefined);
  await updates.command({ action: "download", target: "desktop" }); fake.finishDownload(); await settle();
  await updates.command({ action: "check", target: "desktop" }); assert.equal(updates.snapshot().desktop.state.kind, "update-downloaded");
  await updates.command({ action: "install", target: "desktop" }); assert.deepEqual(installed, ["desktop"]);
  assert.equal(updates.snapshot().step.currentVersion, "0.1.2");
});

test("download preparation has no fabricated percentage; sub-one-percent progress remains visible", async () => {
  const fake = new FakeUpdater();
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, { desktop: "1.0.2", step: "0.1.3" }, "D:/Temp/harness-updater-test", async () => {}, () => {});
  await updates.command({ action: "check", target: "desktop" }); fake.finishCheck(); await settle();
  await updates.command({ action: "download", target: "desktop" });
  assert.equal(updates.snapshot().desktop.state.kind, "download-progress");
  assert.equal((updates.snapshot().desktop.state as { downloadPhase?: string }).downloadPhase, "preparing");
  fake.emit("download-progress", { percent: 0.36, transferred: 3600, total: 1000000, bytesPerSecond: 1200 });
  const state = updates.snapshot().desktop.state;
  assert.equal(state.kind, "download-progress");
  if (state.kind === "download-progress") {
    assert.equal(state.progress, "0.4");
    assert.equal(state.transferredBytes, 3600);
  }
  await updates.command({ action: "cancel", target: "desktop" }); await settle();
  fake.emit("download-progress", { percent: 50, transferred: 500000, total: 1000000 });
  fake.emit("update-downloaded", { version: "0.2.0" });
  assert.equal(updates.snapshot().desktop.state.kind, "update-available");
});

test("idle download deadline cancels the transport and enables explicit retry", async () => {
  const fake = new FakeUpdater();
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, { desktop: "1.0.2", step: "0.1.3" }, "D:/Temp/harness-updater-test", async () => {}, () => {}, { downloadIdleTimeoutMs: 20 });
  await updates.command({ action: "check", target: "desktop" }); fake.finishCheck(); await settle();
  await updates.command({ action: "download", target: "desktop" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(updates.snapshot().desktop.state.kind, "update-available");
  assert.equal(updates.snapshot().desktop.error, "HARNESS_DOWNLOAD_STALLED");
  await updates.command({ action: "download", target: "desktop" }); fake.finishDownload(); await settle();
  assert.equal(updates.snapshot().desktop.error, undefined);
  assert.equal(updates.snapshot().desktop.state.kind, "update-downloaded");
});

test("update window waits for the prepared index, instead of displaying a fake downloading state", async t => {
  const fake = new FakeUpdater(); let ready = () => {}; let shown = false;
  const prepared = new Promise<void>(resolve => { ready = resolve; });
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, { desktop: "1.0.2", step: "0.1.3" }, "D:/Temp/harness-updater-test", async () => {}, () => {}, { prepareDesktop: () => prepared });
  t.mock.method(updates.step, "check", async () => ({ kind: "up-to-date", currentVersion: "0.1.3" }));
  const opening = updates.prepareToShow().then(() => { shown = true; });
  fake.finishCheck(); await settle();
  assert.equal(shown, false); assert.equal(updates.snapshot().desktop.state.kind, "checking");
  ready(); await opening;
  assert.equal(shown, true); assert.equal(updates.snapshot().desktop.state.kind, "update-available");
});

test("prepared blockmap is reused only for the exact URL and download hook is restored", async () => {
  const calls: string[] = [];
  const bytes = gzipSync(JSON.stringify({ version: "2", files: [] }));
  const executor = { downloadToBuffer: async (url: URL) => { calls.push(url.href); return bytes; } };
  const prepare = new HarnessPreparedDownload({ httpExecutor: executor } as unknown as AppUpdater);
  const info = { version: "1.0.3", files: [{ url: "StepFun-Harness-1.0.3-win-x64.exe", sha512: "fixture" }], path: "fixture", sha512: "fixture", releaseDate: "2026-10-09" };
  await prepare.prepare(info); await prepare.prepare(info); assert.equal(calls.length, 1);
  const original = executor.downloadToBuffer, restore = prepare.usePrepared();
  const fetcher = executor as { downloadToBuffer: (url: URL, options: { cancellationToken: DownloadCancellationToken }) => Promise<Buffer> };
  await fetcher.downloadToBuffer(new URL(calls[0]), { cancellationToken: new DownloadCancellationToken() });
  assert.equal(calls.length, 1);
  await fetcher.downloadToBuffer(new URL("https://example.com/other.blockmap"), { cancellationToken: new DownloadCancellationToken() });
  assert.equal(calls.length, 2); restore(); assert.equal(executor.downloadToBuffer, original);
});
