import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../src/file/fileService.js";
test("新文件及删除文件的显式即时校验不沿用旧存在性缓存", async () => {
  const root = await mkdtemp(join(tmpdir(), "existence-fresh-")),
    file = join(root, "result.md"),
    service = createFileService();
  try {
    assert.equal((await service.checkFilesExist({ paths: [file] }))[0]?.exists, false);
    await writeFile(file, "created");
    assert.equal(
      (await service.checkFilesExist({ paths: [file], refresh: true }))[0]?.exists,
      true,
    );
    const second = createFileService();
    assert.equal((await second.checkFilesExist({ paths: [file] }))[0]?.exists, true);
    await rm(file);
    assert.equal(
      (await second.checkFilesExist({ paths: [file], refresh: true }))[0]?.exists,
      false,
    );
    await assert.rejects(
      service.checkFilesExist({ paths: Array(16).fill(file), refresh: true }),
      /at most 15/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
