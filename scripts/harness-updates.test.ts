import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AppUpdater, CancellationToken } from "electron-updater";
import { HarnessUpdates, HARNESS_UPDATE_FEED } from "../packages/desktop/src/main/harnessUpdates.js";
import { HarnessPreparedDownload } from "../packages/desktop/src/main/harnessPreparedDownload.js";
import { gzipSync } from "node:zlib";
import { CancellationToken as DownloadCancellationToken } from "electron-updater";
import { probeInstallerConnection, type InstallerRequester } from "../packages/desktop/src/main/harnessInstallerProbe.js";

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
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "0.1.0", async target => { installed.push(target); }, () => {}, { getRunningTaskCount: () => 0 });
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
  assert.deepEqual(installed, ["desktop"], "下载收尾后无需第二次安装命令");
  await updates.command({ action: "check", target: "desktop" }); assert.equal(updates.snapshot().desktop.state.kind, "update-downloaded");
  await updates.command({ action: "install", target: "desktop" }); assert.deepEqual(installed, ["desktop"]);
  assert.deepEqual(Object.keys(updates.snapshot()), ["desktop"]);
});

test("one confirmation waits for active tasks, resumes without UI and installs exactly once", async () => {
  const fake = new FakeUpdater(); let tasks = 2, installs = 0;
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.9", async () => { installs++; }, () => {}, { getRunningTaskCount: () => tasks, taskPollMs: 5 });
  await updates.command({ action: "check" }); fake.finishCheck(); await settle();
  await updates.command({ action: "download", target: "desktop" });
  await updates.command({ action: "download", target: "desktop" });
  assert.equal(fake.downloads, 1);
  fake.finishDownload(); await settle();
  assert.equal(updates.snapshot().desktop.installPhase, "waiting-for-tasks");
  assert.equal(updates.snapshot().desktop.activeTasks, 2); assert.equal(installs, 0);
  await updates.command({ action: "install", target: "desktop" }); assert.equal(installs, 0);
  tasks = 0; await new Promise(r => setTimeout(r, 25));
  assert.equal(installs, 1); assert.equal(updates.snapshot().desktop.installPhase, "installing");
  fake.finishDownload(); await updates.command({ action: "install", target: "desktop" });
  assert.equal(installs, 1);
});

test("cancelling a waiting update revokes automatic restart; cached package requires new consent", async () => {
  const fake = new FakeUpdater(); let tasks = 1, installs = 0;
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.9", async () => { installs++; }, () => {}, { getRunningTaskCount: () => tasks, taskPollMs: 5 });
  await updates.command({ action: "check" }); fake.finishCheck(); await settle();
  await updates.command({ action: "download", target: "desktop" }); fake.finishDownload(); await settle();
  await updates.command({ action: "cancel", target: "desktop" }); tasks = 0;
  fake.finishDownload(); await new Promise(r => setTimeout(r, 25));
  assert.equal(installs, 0); assert.equal(updates.snapshot().desktop.installPhase, undefined);
  await updates.command({ action: "install", target: "desktop" }); await settle();
  assert.equal(installs, 1); assert.equal(fake.downloads, 1);
});

test("download event is insufficient: promise verification failure never installs", async () => {
  const fake = new FakeUpdater(); let installs = 0;
  fake.downloadUpdate = async () => { fake.emit("update-downloaded", { version: "0.2.0" }); throw new Error("checksum mismatch"); };
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.9", async () => { installs++; }, () => {}, { getRunningTaskCount: () => 0 });
  await updates.command({ action: "check" }); fake.finishCheck(); await settle();
  await updates.command({ action: "download", target: "desktop" }); await settle();
  assert.equal(installs, 0); assert.equal(updates.snapshot().desktop.state.kind, "update-available");
  assert.match(updates.snapshot().desktop.error!, /checksum/);
});

test("unknown task status and installation errors stop automatic retries", async () => {
  for (const count of [undefined, () => Number.NaN, () => 0]) {
    const fake = new FakeUpdater(); let installs = 0;
    const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.9", async () => { installs++; throw new Error("installer failed"); }, () => {}, { getRunningTaskCount: count, taskPollMs: 5 });
    await updates.command({ action: "check" }); fake.finishCheck(); await settle();
    await updates.command({ action: "download", target: "desktop" }); fake.finishDownload(); await settle();
    await new Promise(r => setTimeout(r, 25));
    assert.equal(installs, count && count() === 0 ? 1 : 0);
    assert.equal(updates.snapshot().desktop.installPhase, undefined); assert.ok(updates.snapshot().desktop.error);
    if (installs) { await updates.command({ action: "install", target: "desktop" }); await settle(); assert.equal(installs, 2); }
  }
});

test("a task starting at the final quit check returns to waiting without losing consent", async () => {
  const fake = new FakeUpdater(); let tasks = 0, calls = 0;
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.9", async () => { if (++calls === 1) { tasks = 1; throw new Error("HARNESS_TASKS_RUNNING"); } }, () => {}, { getRunningTaskCount: () => tasks, taskPollMs: 5 });
  await updates.command({ action: "check" }); fake.finishCheck(); await settle();
  await updates.command({ action: "download", target: "desktop" }); fake.finishDownload(); await settle();
  assert.equal(updates.snapshot().desktop.installPhase, "waiting-for-tasks");
  await new Promise(r => setTimeout(r, 20)); assert.equal(calls, 1);
  tasks = 0; await new Promise(r => setTimeout(r, 20)); assert.equal(calls, 2);
});

test("download preparation has no fabricated percentage; sub-one-percent progress remains visible", async () => {
  const fake = new FakeUpdater();
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.2", async () => {}, () => {});
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
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.2", async () => {}, () => {}, { downloadIdleTimeoutMs: 20, getRunningTaskCount: () => 0 });
  await updates.command({ action: "check", target: "desktop" }); fake.finishCheck(); await settle();
  await updates.command({ action: "download", target: "desktop" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(updates.snapshot().desktop.state.kind, "update-available");
  assert.equal(updates.snapshot().desktop.error, "HARNESS_DOWNLOAD_STALLED");
  await updates.command({ action: "download", target: "desktop" }); fake.finishDownload(); await settle();
  assert.equal(updates.snapshot().desktop.error, undefined);
  assert.equal(updates.snapshot().desktop.state.kind, "update-downloaded");
});

test("update window waits for the prepared index, instead of displaying a fake downloading state", async () => {
  const fake = new FakeUpdater(); let ready = () => {}; let shown = false;
  const prepared = new Promise<void>(resolve => { ready = resolve; });
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.2", async () => {}, () => {}, { prepareDesktop: () => prepared });
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
  const prepare = new HarnessPreparedDownload({ httpExecutor: executor } as unknown as AppUpdater, async () => {});
  const info = { version: "1.0.3", files: [{ url: "StepFun-Harness-1.0.3-win-x64.exe", sha512: "fixture" }], path: "fixture", sha512: "fixture", releaseDate: "2026-10-09" };
  await prepare.prepare(info); await prepare.prepare(info); assert.equal(calls.length, 1);
  const original = executor.downloadToBuffer, restore = prepare.usePrepared();
  const fetcher = executor as { downloadToBuffer: (url: URL, options: { cancellationToken: DownloadCancellationToken }) => Promise<Buffer> };
  await fetcher.downloadToBuffer(new URL(calls[0]), { cancellationToken: new DownloadCancellationToken() });
  assert.equal(calls.length, 1);
  await fetcher.downloadToBuffer(new URL("https://example.com/other.blockmap"), { cancellationToken: new DownloadCancellationToken() });
  assert.equal(calls.length, 2); restore(); assert.equal(executor.downloadToBuffer, original);
});

test("installer probe accepts real EXE bytes, aborts ignored ranges and rejects HTML or wrong sizes", async () => {
  for (const fixture of [
    { status: 206, headers: { "content-range": "bytes 0-1023/4096" }, bytes: Buffer.from("MZ"), valid: true },
    { status: 200, headers: { "content-length": "4096" }, bytes: Buffer.from("MZlarge stream"), valid: true },
    { status: 200, headers: { "content-length": "4096" }, bytes: Buffer.from("<html>"), valid: false },
    { status: 206, headers: { "content-range": "bytes 0-1023/9000" }, bytes: Buffer.from("MZ"), valid: false },
    { status: 503, headers: {}, bytes: Buffer.from("bad"), valid: false },
  ]) {
    let aborted = false;
    const executor = { createRequest(options: { headers: { Range: string } }, callback: (response: unknown) => void) {
      assert.equal(options.headers.Range, "bytes=0-1023");
      const request = Object.assign(new EventEmitter(), { abort() { aborted = true; }, end() {
        const response = Object.assign(new EventEmitter(), { statusCode: fixture.status, headers: fixture.headers });
        callback(response); response.emit("data", fixture.bytes); response.emit("end");
      } });
      return request;
    } };
    const probe = probeInstallerConnection(executor as unknown as InstallerRequester, new URL("https://example.com/setup.exe"), 4096);
    if (fixture.valid) await probe; else await assert.rejects(probe);
    assert.equal(aborted, true);
  }
});

test("failed installer connection never exposes an update button and the next check can retry", async () => {
  const fake = new FakeUpdater(); let fail = true;
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.5", async () => {}, () => {},
    { prepareDesktop: async () => { if (fail) throw new Error("installer unreachable"); } });
  await updates.command({ action: "check", target: "desktop" }); fake.finishCheck(); await settle();
  assert.equal(updates.snapshot().desktop.state.kind, "idle");
  await assert.rejects(updates.command({ action: "download", target: "desktop" }), /No verified/);
  fail = false; await updates.command({ action: "check", target: "desktop" }); fake.finishCheck(); await settle();
  assert.equal(updates.snapshot().desktop.state.kind, "update-available");
});

test("legacy runtime update requests cannot check, download or activate a separate runtime", async t => {
  let network = 0, installs = 0;
  t.mock.method(globalThis, "fetch", async () => { network++; throw new Error("Unexpected runtime network"); });
  const fake = new FakeUpdater();
  const updates = new HarnessUpdates(fake as unknown as AppUpdater, "1.0.6", async () => { installs++; }, () => {});
  for (const action of ["snapshot", "check", "download", "cancel", "install"]) {
    await assert.rejects(updates.command(JSON.parse(JSON.stringify({ action, target: "step" }))), /Invalid update target/);
  }
  assert.equal(network, 0); assert.equal(installs, 0); assert.equal(fake.checks, 0);
  await updates.command({ action: "check" }); fake.finishCheck(); await settle();
  assert.equal(fake.checks, 1); assert.equal(network, 0);
  assert.deepEqual(Object.keys(updates.snapshot()), ["desktop"]);
});
