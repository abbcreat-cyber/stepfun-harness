import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripSourceMappingUrlCommentsInDirectory } from "../packages/desktop/scripts/packaged-sourcemap-cleanup.mjs";

test("packaging preserves executable template strings inside the bundled runtime", async t => {
  const root = await mkdtemp(join(process.cwd(), ".release-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "harness-runtime"); await mkdir(runtime);
  const file = join(runtime, "loader.mjs");
  const source = 'export const prefix = `\n//# sourceMappingURL=data:application/json;base64,`;\nexport const result = prefix + "fixture";';
  await writeFile(file, source);
  stripSourceMappingUrlCommentsInDirectory(root);
  assert.equal(await readFile(file, "utf8"), source);
  assert.ok((await import(pathToFileURL(file).href)).result.endsWith("fixture"));
});
