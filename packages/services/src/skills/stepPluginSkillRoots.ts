import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { withFileLock, atomicWritePrivateTextFile } from "@zcode/shared/node";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { walkSkillMarkdownPaths } from "./skillDiscoveryWalk.js";

type Manifest = {
  id: string;
  skills?: string[];
  stepOfficial?: boolean;
  stepSkillSelection?: { roots: string[]; disabled: string[] };
};

function pluginDirectory(): string | null {
  return process.env.STEP_BACKEND === "stepcode-local" && process.env.STEPCODE_STORAGE_ROOT_DIR
    ? join(process.env.STEPCODE_STORAGE_ROOT_DIR, "plugins")
    : null;
}

function inside(root: string, path: string): string | null {
  const absolute = resolve(root, path),
    rel = relative(root, absolute);
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) ? null : absolute;
}

async function activePlugins() {
  const directory = pluginDirectory();
  if (!directory) return null;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(directory, entry.name);
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await readFile(join(root, "step.plugin.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    plugins.push({
      root,
      manifest,
      pluginId: `${manifest.id}@${manifest.stepOfficial ? "zcode-plugins-official" : "stepcode"}`,
    });
  }
  return plugins;
}

function sourceRoots(manifest: Manifest): string[] {
  return manifest.stepSkillSelection?.roots ?? manifest.skills ?? ["skills"];
}

/** Step 的启停事实在插件清单；菜单保留原声明以便重新开启单技能。 */
export async function readStepPluginSkillRoots() {
  const plugins = await activePlugins();
  if (!plugins) return null;
  const result = [];
  for (const { root, manifest, pluginId } of plugins) {
    for (const path of await skillPaths(root, sourceRoots(manifest))) {
      result.push({
        scope: "plugin" as const,
        rootPath: join(root, path),
        pluginName: manifest.id,
        pluginId,
      });
    }
  }
  return result;
}

export async function readStepPluginSkillDisabledPaths(): Promise<Set<string> | null> {
  const plugins = await activePlugins();
  if (!plugins) return null;
  const disabled = new Set<string>();
  for (const { root, manifest } of plugins) {
    for (const path of manifest.stepSkillSelection?.disabled ?? []) {
      const absolute = inside(root, path);
      if (absolute)
        disabled.add((await realpath(absolute).catch(() => absolute)).replaceAll("\\", "/"));
    }
  }
  return disabled;
}

async function skillPaths(root: string, roots: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const declared of roots) {
    const path = inside(root, declared);
    if (!path) continue;
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isFile() && basename(path) === "SKILL.md") files.add(path);
    else if (info.isDirectory()) {
      const candidates = [];
      for await (const file of walkSkillMarkdownPaths(path, {
        onError: (_path, error) => {
          throw error;
        },
      }))
        candidates.push(file);
      // 原生 Step 进入含 SKILL.md 的目录后不再递归；不能把 examples 内的技能意外启用。
      for (const file of candidates) {
        if (!candidates.some((parent) => parent !== file && inside(dirname(parent), file)))
          files.add(file);
      }
    }
  }
  // 相对文件投影保持脚本路径，且避免父技能目录把已关闭的嵌套技能重新带入。
  return [...files].map((file) => relative(root, file).replaceAll("\\", "/")).sort();
}

export async function setStepPluginSkillEnabled(
  skill: { pluginId?: string; sourcePath?: string; path: string },
  enabled: boolean,
): Promise<boolean> {
  const directory = pluginDirectory();
  if (!directory || !skill.pluginId) return false;
  return withFileLock(join(resolve(dirname(directory)), ".step-plugin-state"), () =>
    updateSkillSelection(skill, enabled),
  );
}

async function updateSkillSelection(
  skill: { pluginId?: string; sourcePath?: string; path: string },
  enabled: boolean,
): Promise<boolean> {
  const plugins = await activePlugins();
  if (!plugins || !skill.pluginId) return false;
  const plugin = plugins.find((item) => item.pluginId === skill.pluginId);
  if (!plugin) throw new Error(`Step plugin is no longer active: ${skill.pluginId}`);
  const { root, manifest } = plugin;
  const roots = sourceRoots(manifest);
  const files = await skillPaths(root, roots);
  const target = relative(root, skill.sourcePath ?? skill.path).replaceAll("\\", "/");
  if (!files.includes(target))
    throw new Error("Skill is outside the active Step plugin declaration");
  const disabled = new Set(manifest.stepSkillSelection?.disabled ?? []);
  if (enabled) disabled.delete(target);
  else disabled.add(target);
  manifest.stepSkillSelection = { roots, disabled: [...disabled].sort() };
  manifest.skills = files.filter((file) => !disabled.has(file));
  const destination = join(root, "step.plugin.json");
  const body = JSON.stringify(manifest, null, 2);
  if ((await readFile(destination, "utf8")) === body) return true;
  // 单文件原子替换同时发布选择事实和底座投影；失败时不写 ZCode 假状态，不动资产。
  await atomicWritePrivateTextFile(destination, body);
  return true;
}
