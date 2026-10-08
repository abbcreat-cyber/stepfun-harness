import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AppUpdater, CancellationToken } from "electron-updater";
import { HarnessUpdates, HARNESS_UPDATE_FEED } from "../packages/desktop/src/main/harnessUpdates.js";

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
