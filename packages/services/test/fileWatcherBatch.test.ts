import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWatcherService } from "../src/fileWatcher/fileWatcherService.js";
import type { FileWatchEvent } from "@zcode/shared";

test("真实目录监听保留批次完整路径，超限回退目录刷新", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "watch-batch-")),
    service = createFileWatcherService();
  try {
    const { id } = await service.watch({ path: root });
    async function change(names: string[]) {
      const event = new Promise<FileWatchEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          subscription.dispose();
          reject(Error("watch deadline"));
        }, 4000);
        const subscription = service.onDynamicChange(id)((value) => {
          clearTimeout(timer);
          subscription.dispose();
          resolve(value);
        });
      });
      await Promise.all(names.map((name) => writeFile(join(root, name), "change")));
      return event;
    }
    const single = await change(["one.txt"]);
    assert.equal(single.changedPath, join(root, "one.txt"));
    const pair = await change(["a.txt", "b.txt"]);
    assert.equal(pair.changedPath, undefined);
    assert.deepEqual(pair.changedPaths?.sort(), [join(root, "a.txt"), join(root, "b.txt")].sort());
    const many = await change(Array.from({ length: 70 }, (_, i) => "bulk-" + i + ".txt"));
    assert.equal(many.changedPath, undefined);
    assert.equal(many.changedPaths, undefined);
  } finally {
    service.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});
