import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessEnvironment, stepCommand } from "./harness.mjs";
import { join } from "node:path";
test("launcher derives all product paths from selected home and repository", () => {
  const root = process.platform === "win32" ? "D:/Example Repo" : "/tmp/example-repo";
  const home = process.platform === "win32" ? "D:/Example Data" : "/tmp/example-home";
  const env = harnessEnvironment({ HARNESS_HOME: home }, root);
  assert.equal(env.STEPCODE_BRIDGE_ENTRY, join(root, "packages/stepcode-adapter/bin/zcode-bridge.mjs"));
  assert.equal(env.STEPCODE_STORAGE_ROOT_DIR, join(home, "state"));
  assert.equal(env.STEP_BACKEND, "stepcode-local");
  assert.ok(!JSON.stringify(env).includes("12647"));
});
test("explicit missing Step executable fails rather than falling back to a mock", () => {
  assert.throws(() => stepCommand({ HARNESS_STEP_BIN: "./missing-executable-never-present" }), /Step runtime not found/);
});
