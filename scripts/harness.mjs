import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
export function harnessEnvironment(base = process.env, repo = repository) {
  const home = resolve(base.HARNESS_HOME || join(homedir(), ".stepfun-harness"));
  return { ...base, STEP_BACKEND: "stepcode-local", ZCODE_ENV: "production",
    STEPCODE_NODE: process.execPath,
    STEPCODE_BRIDGE_ENTRY: join(repo, "packages/stepcode-adapter/bin/zcode-bridge.mjs"),
    STEPCODE_OFFICIAL_PLUGIN_SOURCE: join(repo, "vendor/step-official-plugins"),
    STEPCODE_SETTINGS_DIR: join(home, "settings"), STEPCODE_STORAGE_ROOT_DIR: join(home, "state"),
    STEPCODE_RUNTIME_DIR: join(home, "runtime"), STEP_CODING_AGENT_DIR: join(home, "agent"),
    STEPCODE_CONVERSATION_DIR: join(home, "conversations"), STEPCODE_DEFAULT_PROJECT_DIR: join(home, "workspace"),
    STEPCODE_DESKTOP_CREDENTIALS: join(home, "state/desktop-credentials.json"),
    ZCODE_DESKTOP_APPLICATION_NAME: "StepFun Harness", ZCODE_DESKTOP_USER_DATA_DIR: join(home, "electron"),
    ZCODE_DESKTOP_SESSION_DATA_DIR: join(home, "electron/session"), ZCODE_DESKTOP_HOME_DIR: join(home, "home"),
    ZCODE_DATA_BASE_DIR: join(home, "data"),
    STEPCODE_TASKBAR_ICON: join(repo, "packages/desktop/build/icon.ico"),
    STEPCODE_DOCUMENT_RUNTIME_DIR: resolve(base.HARNESS_DOCUMENT_RUNTIME || join(home, "tools")),
  };
}
export function stepCommand(env) {
  const candidates = [];
  if (env.HARNESS_STEP_BIN) candidates.push(resolve(env.HARNESS_STEP_BIN));
  else {
    candidates.push(join(homedir(), ".stepcode/bin", process.platform === "win32" ? "step.exe" : "step"), "step");
  }
  for (const command of candidates) {
    try { const version = execFileSync(command, ["--version"], { windowsHide: true, timeout: 15000, encoding: "utf8", env }).trim();
      if (/\d+\.\d+\.\d+/.test(version)) return { command, version: version.replace(/^v/, "") };
    } catch {}
  }
  throw new Error("Step runtime not found. Install Step-Code first, or set HARNESS_STEP_BIN to its executable. See docs/GETTING-STARTED.md.");
}
export async function main(mode = process.argv[2] || "start") {
  const env = harnessEnvironment();
  if (mode === "start") {
    const exe = env.HARNESS_DESKTOP_EXE || join(repository, "packages/desktop/dist/win-unpacked/StepFun Harness.exe");
    if (!existsSync(exe)) throw new Error("Packaged app not found. Build it first or set HARNESS_DESKTOP_EXE.");
    const child = spawn(exe, [], { env, detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", e => { console.error(e.message); process.exitCode = 1; }); child.unref(); return;
  }
  if (["build", "pack"].includes(mode)) {
    const { preparePlugins } = await import("./prepare-harness-plugins.mjs"); await preparePlugins();
    const args = mode === "build" ? ["--filter", "@zcode/desktop", "build"] : ["bundle:desktop", "win", "x64", "--skip-prepare", "--skip-build"];
    const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { cwd: repository, env: { ...env, ZCODE_SKIP_REMOTE_ASSETS: "1" }, stdio: "inherit", shell: process.platform === "win32", windowsHide: true });
    child.on("error", e => { console.error(e.message); process.exitCode = 1; }); child.on("exit", code => { process.exitCode = code ?? 1; }); return;
  }
  const step = stepCommand(env);
  env.STEPCODE_RUNTIME_VERSION = step.version;
  env.STEPCODE_BRIDGE_ARGS_JSON = JSON.stringify(["--step-cli", JSON.stringify([step.command, "--mode", "rpc"]), "--state-dir", join(env.STEPCODE_STORAGE_ROOT_DIR, "bridge-state")]);
  if (mode === "doctor") { console.log(JSON.stringify({ step: step.command, version: step.version, repo: repository, data: env.STEPCODE_STORAGE_ROOT_DIR, bundledPlugins: existsSync(join(env.STEPCODE_OFFICIAL_PLUGIN_SOURCE, "catalog.json")), hooks: ["first-principles", "opening-explanation"] }, null, 2)); return; }
  for (const dir of [env.STEPCODE_STORAGE_ROOT_DIR, env.STEPCODE_SETTINGS_DIR, env.STEPCODE_CONVERSATION_DIR, env.STEPCODE_DEFAULT_PROJECT_DIR]) mkdirSync(dir, { recursive: true });
  if (mode === "dev") {
    const child = spawn(process.execPath, [join(repository, "scripts/dev-desktop-env.mjs"), "production"], { cwd: repository, env, stdio: "inherit", windowsHide: true });
    child.on("error", e => { console.error(e.message); process.exitCode = 1; }); child.on("exit", code => { process.exitCode = code ?? 1; }); return;
  }
  throw new Error("Usage: node scripts/harness.mjs doctor|dev|build|pack|start");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
