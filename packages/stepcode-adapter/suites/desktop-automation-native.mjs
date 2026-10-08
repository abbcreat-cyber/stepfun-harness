import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test(
  "real SDK desktop cron tools persist to Host DB and management API across restart",
  {
    skip: !process.env.STEP_TEST_CLI,
    timeout: 120000,
  },
  async () => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./desktop-automation-native-fixture.mjs", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: { ...process.env, NODE_OPTIONS: "" },
        windowsHide: true,
        timeout: 100000,
        maxBuffer: 1000000,
      },
    );
    assert.equal(JSON.parse(result.stdout).pass, true);
  },
);

test(
  "real Host reverse handler and original bound CronRun consumers use the same persistent task",
  {
    skip: !process.env.STEP_TEST_CLI,
    timeout: 120000,
  },
  async () => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./desktop-automation-host-fixture.mjs", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: { ...process.env, NODE_OPTIONS: "" },
        windowsHide: true,
        timeout: 100000,
        maxBuffer: 2000000,
      },
    );
    assert.ok(result.stdout.includes('"pass":true'), result.stdout);
  },
);
