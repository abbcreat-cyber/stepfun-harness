import { access, mkdir, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

export async function packagedEnvironment(resources, home, base = process.env) {
  const root = join(resources, "harness-runtime");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.stepVersion)) {
    throw new Error("Invalid Harness runtime manifest");
  }
  const env = { ...base };
  // 发布入口必须覆盖开发机残留的桥接变量，否则双击仍可能连接到作者目录。
  for (const key of Object.keys(env)) {
    if (/^(STEPCODE_|STEP_CODING_AGENT_DIR$|ZCODE_DESKTOP_|ZCODE_DATA_BASE_DIR$|NODE_PATH$|NODE_OPTIONS$|PYTHONHOME$|PYTHONPATH$)/i.test(key)) delete env[key];
  }
  const data = resolve(home), runtime = join(data, "runtime");
  let step = join(root, "step", "step.exe"), version = manifest.stepVersion;
  try {
    const pointer = JSON.parse(await readFile(join(runtime, "current.json"), "utf8"));
    const expected = join(runtime, `version-${pointer.version}`, "files");
    const inside = typeof pointer.executable === "string" ? relative(expected, resolve(pointer.executable)) : "..";
    if (!/^\d+\.\d+\.\d+$/.test(pointer.version) || inside.startsWith("..") || isAbsolute(inside) || !inside) throw new Error("Invalid Step update pointer");
    const order = pointer.version.split(".").map((n, i) => Number(n) - Number(manifest.stepVersion.split(".")[i])).find(n => n !== 0) ?? 0;
    if (order >= 0) { await access(pointer.executable); step = resolve(pointer.executable); version = pointer.version; }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  Object.assign(env, {
    STEP_BACKEND: "stepcode-local", ZCODE_ENV: "production",
    STEPCODE_NODE: join(root, "node", "node.exe"),
    STEPCODE_BRIDGE_ENTRY: join(root, "adapter", "bin", "zcode-bridge.mjs"),
    STEPCODE_BRIDGE_ARGS_JSON: JSON.stringify(["--step-cli", JSON.stringify([step, "--mode", "rpc"]), "--state-dir", join(data, "state", "bridge-state"), "--log-file", join(data, "logs", `bridge-${process.pid}.log`)]),
    STEPCODE_OFFICIAL_PLUGIN_SOURCE: join(resources, "step-official-plugins"),
    STEPCODE_SETTINGS_DIR: join(data, "settings"), STEPCODE_STORAGE_ROOT_DIR: join(data, "state"),
    STEPCODE_LOG_DIR: join(data, "logs"),
    STEPCODE_RUNTIME_DIR: runtime, STEPCODE_RUNTIME_VERSION: version,
    STEP_CODING_AGENT_DIR: join(data, "agent"), STEPCODE_CONVERSATION_DIR: join(data, "conversations"),
    STEPCODE_DEFAULT_PROJECT_DIR: join(data, "workspace"), STEPCODE_DESKTOP_CREDENTIALS: join(data, "state", "desktop-credentials.json"),
    STEPCODE_DOCUMENT_RUNTIME_DIR: join(root, "tools"), STEPCODE_GIT_BASH: join(root, "git", "bin", "bash.exe"),
    STEPCODE_TASKBAR_ICON: join(resources, "icon.ico"),
    ZCODE_DESKTOP_APPLICATION_NAME: "StepFun Harness", ZCODE_DESKTOP_USER_DATA_DIR: join(data, "electron"),
    ZCODE_DESKTOP_SESSION_DATA_DIR: join(data, "electron", "session"), ZCODE_DESKTOP_HOME_DIR: join(data, "home"),
    ZCODE_DATA_BASE_DIR: join(data, "data"),
    NODE_PATH: join(root, "tools", "document-node", "node_modules"),
  });
  if (base.STEPCODE_BACKGROUND === "1") env.STEPCODE_BACKGROUND = "1";
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path");
  const previousPath = pathKey ? env[pathKey] : "";
  if (pathKey) delete env[pathKey];
  env.PATH = [join(root, "node"), join(root, "git", "cmd"), join(root, "git", "bin"),
    join(root, "tools", "document-python", "Scripts"),
    join(root, "tools", "LibreOffice25.8.4.2", "SourceDir", "LibreOffice", "program"), previousPath].filter(Boolean).join(delimiter);
  for (const file of [step, env.STEPCODE_NODE, env.STEPCODE_BRIDGE_ENTRY, env.STEPCODE_GIT_BASH,
    join(env.STEPCODE_OFFICIAL_PLUGIN_SOURCE, "catalog.json"), join(root, "tools", "document-python", "Scripts", "python.exe")]) await access(file);
  for (const dir of ["settings", "state", "runtime", "agent", "logs", "conversations", "workspace", "electron/session", "home", "data"]) await mkdir(join(data, dir), { recursive: true });
  return env;
}
