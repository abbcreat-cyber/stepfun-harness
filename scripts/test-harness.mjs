import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(".release-check/tests");
await mkdir(root, { recursive: true });
const child = spawn(process.execPath, ["--import", "tsx", "--test",
  "scripts/harness.test.mjs", "scripts/packaged-harness.test.mjs", "scripts/harness-updates.test.ts", "scripts/runtime-preservation.test.mjs",
  "packages/stepcode-adapter/suites/assistant-opening-hook.mjs", "packages/stepcode-adapter/suites/desktop-plugin-context.mjs", "packages/stepcode-adapter/suites/marketplace-refresh.mjs"],
{ stdio: "inherit", windowsHide: true, env: { ...process.env, STEP_TEST_ROOT: root } });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
