import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Windows 环境键不区分大小写；后加的会话覆盖必须优先于父进程的 Path。 */
export function mergeDesktopEnvironment(base, overrides, platform = process.platform) {
  const next = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (platform === "win32") {
      for (const previous of Object.keys(next)) {
        if (previous.toLowerCase() === key.toLowerCase()) delete next[previous];
      }
    }
    next[key] = value;
  }
  return next;
}

function windowsValue(env, name) {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/** 只读安装注册表，非默认盘符不能靠硬编码或父应用的旧 PATH 推断。 */
async function installedGitRoots(env) {
  const registry = win32.join(windowsValue(env, "SystemRoot") || "C:\\Windows", "System32", "reg.exe");
  const results = await Promise.all([
    "HKCU\\SOFTWARE\\GitForWindows",
    "HKLM\\SOFTWARE\\GitForWindows",
    "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
  ].map(async key => {
    try {
      const { stdout } = await execute(registry, ["query", key, "/v", "InstallPath"], { windowsHide: true, timeout: 3000 });
      return stdout.match(/InstallPath\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim();
    } catch { return undefined; }
  }));
  return results.filter(Boolean);
}

export async function resolveDesktopShellEnvironment(env) {
  const selected = desktopShellEnvironment(env);
  if (process.platform !== "win32" || selected.bash) return selected;
  return desktopShellEnvironment(env, "win32", existsSync, await installedGitRoots(env));
}

/** 仅调整桌面子进程环境：Git Bash 优先于 Windows 的 WSL bash.exe 兼容入口。 */
export function desktopShellEnvironment(
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  installedRoots = [],
) {
  if (platform !== "win32") return { env, bash: null };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const dirs = (env[pathKey] ?? "").split(";").map((dir) => dir.trim().replace(/^"|"$/g, ""));
  const toolRoot=windowsValue(env,"STEPCODE_DOCUMENT_RUNTIME_DIR");
  const documentDirs=toolRoot?[win32.join(toolRoot,"document-python","Scripts"),win32.join(toolRoot,"office","bin"),win32.join(toolRoot,"LibreOffice25.8.4.2","SourceDir","LibreOffice","program")].filter(dir=>exists(win32.join(dir,"python.exe"))||exists(win32.join(dir,"soffice.exe"))):[];
  const explicit = windowsValue(env, "STEPCODE_GIT_BASH")?.trim();
  if (explicit && (!win32.isAbsolute(explicit) || !exists(explicit))) {
    throw new Error("配置的 Git Bash 路径不存在或不是绝对路径，请检查 STEPCODE_GIT_BASH");
  }
  const candidates = explicit ? [explicit] : [];
  for (const dir of dirs) {
    if (!dir || !exists(win32.join(dir, "git.exe"))) continue;
    candidates.push(win32.join(dir, "bash.exe"), win32.join(dir, "..", "bin", "bash.exe"), win32.join(dir, "..", "..", "bin", "bash.exe"));
  }
  for (const root of [
    ...[windowsValue(env, "ProgramFiles"), windowsValue(env, "ProgramFiles(x86)")].filter(Boolean).map(root => win32.join(root, "Git")),
    ...installedRoots,
  ]) candidates.push(win32.join(root, "bin", "bash.exe"));
  for (const bash of candidates) {
    if (!exists(bash)) continue;
    const next = { ...env };
    for (const key of Object.keys(next)) if (key.toLowerCase() === "path") delete next[key];
    // Step 用 where.exe 搜索 Bash；只加 Git bin 而缺少 System32，仍会报告 No bash shell found。
    const system32 = win32.join(windowsValue(env, "SystemRoot") || "C:\\Windows", "System32");
    const nativeLookup = exists(win32.join(system32, "where.exe")) && !dirs.some(d => win32.normalize(d).toLowerCase() === system32.toLowerCase()) ? [system32] : [];
    next[pathKey] = [
      ...documentDirs,
      win32.dirname(bash),
      ...dirs.filter((d) => d.toLowerCase() !== win32.dirname(bash).toLowerCase()),
      ...nativeLookup,
    ].join(";");
    next.STEPCODE_GIT_BASH = bash;
    if(toolRoot){const modules=win32.join(toolRoot,"document-node","node_modules");if(exists(modules))next.NODE_PATH=[modules,windowsValue(next,"NODE_PATH")].filter(Boolean).join(";");const office=win32.join(toolRoot,"office","office.mjs");if(exists(office))next.HARNESS_OFFICE_CLI=office;
      // 中文 Windows 管道默认 GBK；文档质检的 Unicode 标记会导致 Python 输出即崩溃。
      next.PYTHONUTF8 = windowsValue(next,"PYTHONUTF8") ?? "1";
      next.PYTHONIOENCODING = windowsValue(next,"PYTHONIOENCODING") ?? "utf-8";
    }
    return { env: next, bash };
  }
  return { env, bash: null };
}
