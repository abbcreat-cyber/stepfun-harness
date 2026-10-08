import test from "node:test";
import assert from "node:assert/strict";
import { stepLaunchCredentials, stepLaunchProfile } from "./step-launch-policy.mjs";

test("无 Key 可生成启动环境，不注入空凭据、不改变原环境", () => {
  const source = { Path: "keep", STEPFUN_API_KEY: " " };
  assert.deepEqual(stepLaunchCredentials(source), { Path: "keep" });
  assert.equal(source.STEPFUN_API_KEY, " ");
});
test("两种已有 Key 来源均保留且使用同一真实值", () => {
  for (const field of ["STEP_API_KEY", "STEPFUN_API_KEY"]) {
    assert.deepEqual(stepLaunchCredentials({ [field]: " fixture " }), { STEP_API_KEY: "fixture", STEPFUN_API_KEY: "fixture" });
  }
});
test("独立 profile 隔离 Key、会话、SDK 与窗口实例路径", () => {
  assert.deepEqual(stepLaunchProfile(undefined), {});
  const result = stepLaunchProfile(process.platform === "win32" ? "D:/isolated-step" : "/isolated-step");
  assert.notEqual(result.STEPCODE_STORAGE_ROOT_DIR, result.ZCODE_DESKTOP_USER_DATA_DIR);
  assert.ok(result.STEPCODE_DESKTOP_CREDENTIALS.endsWith("desktop-credentials.json"));
  assert.throws(() => stepLaunchProfile("relative"), /absolute/);
});
