import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessDownloadProgress } from "../src/lib/harnessDownloadProgress.js";
test("preparation and unknown totals never invent a zero percent progress bar", () => {
  const result = harnessDownloadProgress({ kind: "download-progress", enabled: true, progress: "", downloadPhase: "preparing" }, false);
  assert.equal(result.determinate, false); assert.doesNotMatch(result.label, /0%/);
  const unknown = harnessDownloadProgress({ kind: "download-progress", enabled: true, progress: "0", transferredBytes: 1200, totalBytes: 0 }, true);
  assert.equal(unknown.determinate, false); assert.match(unknown.bytes, /1.2 KB/);
});
test("small real transfers remain visible, verification is not installation ready", () => {
  const result = harnessDownloadProgress({ kind: "download-progress", enabled: true, progress: "0.4", transferredBytes: 3600, totalBytes: 1000000, bytesPerSecond: 1200 }, false);
  assert.match(result.label, /0.4%/); assert.equal(result.bytes, "3.6 KB / 1.00 MB · 1.2 KB/s");
  assert.equal(harnessDownloadProgress({ kind: "download-progress", enabled: true, progress: "100", downloadPhase: "verifying" }, false).determinate, false);
});
