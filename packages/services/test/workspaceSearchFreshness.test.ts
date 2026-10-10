import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../src/file/fileService.js";

async function fixture() {
  const base = process.env.STEP_TEST_ROOT || tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "workspace-search-"));
}

test("warm search immediately follows a renamed file and removes a deleted match", async () => {
  const rootPath = await fixture(), service = createFileService();
  await writeFile(join(rootPath, "report-before.md"), "unchanged");
  const query = { rootPath, query: "report", limit: 80 };
  assert.deepEqual((await service.searchWorkspaceFiles(query)).map(x => x.name), ["report-before.md"]);
  await rename(join(rootPath, "report-before.md"), join(rootPath, "report-after.md"));
  assert.deepEqual((await service.searchWorkspaceFiles(query)).map(x => x.name), ["report-after.md"]);
  await rm(join(rootPath, "report-after.md"));
  assert.deepEqual(await service.searchWorkspaceFiles(query), []);
});

test("renamed parent directories and changed entry types cannot leave stale search results", async () => {
  const rootPath = await fixture(), otherRoot = await fixture(), service = createFileService();
  await mkdir(join(rootPath, "before"));
  await writeFile(join(rootPath, "before/report.md"), "data");
  await writeFile(join(otherRoot, "report-other.md"), "other workspace");
  const query = { rootPath, query: "report", limit: 80 };
  await service.searchWorkspaceFiles(query);
  await service.searchWorkspaceFiles({ ...query, rootPath: otherRoot });
  await rename(join(rootPath, "before"), join(rootPath, "after"));
  assert.deepEqual((await service.searchWorkspaceFiles(query)).map(x => x.relativePath), ["after/report.md"]);
  await rm(join(rootPath, "after/report.md"));
  await mkdir(join(rootPath, "after/report.md"));
  assert.equal((await service.searchWorkspaceFiles(query))[0]?.type, "directory");
  assert.deepEqual((await service.searchWorkspaceFiles({ ...query, rootPath: otherRoot })).map(x => x.name), ["report-other.md"]);
});
