import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { packagedEnvironment } from "../packages/desktop/src/harness-environment.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(process.cwd(), ".release-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const resources = join(dir, "Moved App/resources"), home = join(dir, "New User"), runtime = join(resources, "harness-runtime");
  for (const path of ["step/step.exe", "node/node.exe", "adapter/bin/zcode-bridge.mjs", "git/bin/bash.exe", "tools/document-python/Scripts/python.exe", "../step-official-plugins/catalog.json"]) {
    await mkdir(join(runtime, path, ".."), { recursive: true }); await writeFile(join(runtime, path), "fixture");
  }
  await writeFile(join(runtime, "manifest.json"), JSON.stringify({ schema: 1, stepVersion: "0.1.2" }));
  return { resources, home };
}
test("packaged launch relocates all paths and discards stale author environment", async t => {
  const { resources, home } = await fixture(t);
  const env = await packagedEnvironment(resources, home, { STEPCODE_BRIDGE_ENTRY: "X:/old-repo/bridge.mjs", STEPCODE_PROFILE_DIR: "X:/old-profile", Path: "C:/Windows/System32", NODE_OPTIONS: "--require bad.js" });
  assert.equal(env.STEP_BACKEND, "stepcode-local");
  assert.equal(env.STEPCODE_STORAGE_ROOT_DIR, join(home, "state"));
  assert.ok(env.STEPCODE_BRIDGE_ENTRY.startsWith(resources));
  assert.ok(!JSON.stringify(env).includes("X:/"));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(Object.keys(env).filter(k => k.toLowerCase() === "path").length, 1);
});
test("update pointer must stay inside its own version directory", async t => {
  const { resources, home } = await fixture(t);
  await mkdir(join(home, "runtime"), { recursive: true });
  await writeFile(join(home, "runtime/current.json"), JSON.stringify({ version: "0.1.3", executable: "C:/other/step.exe" }));
  await assert.rejects(packagedEnvironment(resources, home, {}), /Invalid Step update pointer/);
});
test("validated updater directory overrides bundled Step without changing adapter", async t => {
  const { resources, home } = await fixture(t);
  const executable = join(home, "runtime/version-0.1.3/files/step.exe");
  await mkdir(join(executable, ".."), { recursive: true }); await writeFile(executable, "fixture");
  await writeFile(join(home, "runtime/current.json"), JSON.stringify({ version: "0.1.3", executable }));
  const env = await packagedEnvironment(resources, home, {});
  assert.equal(env.STEPCODE_RUNTIME_VERSION, "0.1.3");
  assert.ok(env.STEPCODE_BRIDGE_ARGS_JSON.includes("0.1.3"));
});
