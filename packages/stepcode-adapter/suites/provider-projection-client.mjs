import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 单操作子进程避免测试聚合器已有 register()/namespace loader 相互锁住。 */
export function projectionFixture(input) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" };
    for (const key of Object.keys(env))
      if (/API_KEY|TOKEN|SECRET|PROXY|^(STEP_|STEPCODE_)/i.test(key)) delete env[key];
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./provider-projection-fixture.mjs", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 20000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-2000)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error("Production projection fixture timed out; isolated loader process stopped"),
        );
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (!result.ok || code !== 0) throw new Error(result.error || `projection exited ${code}`);
        resolve(result.value);
      } catch (error) {
        reject(new Error(`${error.message}${stderr ? `; stderr=${stderr}` : ""}`));
      }
    });
    child.stdin.on("error", (error) => {
      if (!timedOut) reject(error);
    });
    const payload = input.env
      ? {
          ...input,
          env: Object.fromEntries(
            ["HOME", "USERPROFILE", "STEP_CODING_AGENT_DIR"].map((key) => [key, input.env[key]]),
          ),
        }
      : input;
    child.stdin.end(JSON.stringify(payload));
  });
}
