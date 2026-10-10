import { cp, mkdir, readFile, readdir, writeFile, access, rename } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { retireMissingBundledPlugins } from "./builtin-plugin-availability.mjs";
import { refreshBundledOfficeNotice } from "./bundled-office-notice.mjs";
export {pluginConfigSignature,readPluginConfigSnapshot,resolveStartedPluginSignature} from './plugin-config-signature.mjs';
import {
  withStepPluginState,
  writeStepPluginState,
  readStepPluginDeclaration,
  STEP_PLUGIN_DISABLED_MANIFEST,
} from "./plugin-state.mjs";

export const OFFICIAL_MARKETPLACE = "zcode-plugins-official";
export const OFFICIAL_PLUGIN_NAMES = [
  "node-repl-host",
  "android-emulator",
  "browser-use",
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "image-search",
  "ios-simulator",
  "restore-legacy-sessions",
  "plugin-creator",
  "skill-creator",
  "zcode-guide",
  "computer-use",
];
const labels = {
  "node-repl-host": "Node Repl Host",
  "android-emulator": "Android 模拟器",
  "browser-use": "浏览器操作",
  documents: "Word文档",
  pdf: "PDF",
  presentations: "演示文档",
  spreadsheets: "电子表格",
  "image-search": "搜图",
  "ios-simulator": "iOS 模拟器",
  "restore-legacy-sessions": "恢复旧版会话",
  "plugin-creator": "插件创建器",
  "skill-creator": "技能创建器",
  "zcode-guide": "Step Code 使用指南",
  "computer-use": "电脑操作",
};
const seeds = new Map();
export function isUnavailableOfficialPlugin(name) {
  return (
    [
      "computer-use",
      "image-search",
      "restore-legacy-sessions",
      "plugin-creator",
      "zcode-guide",
    ].includes(name) ||
    (name === "ios-simulator" && process.platform !== "darwin")
  );
}
export function officialPluginSource() {
  return (
    process.env.STEPCODE_OFFICIAL_PLUGIN_SOURCE ||
    fileURLToPath(new URL("../../desktop/build/step-official-plugins", import.meta.url))
  );
}
export function parseStepPluginId(id) {
  const value = String(id),
    parts = value.split("@");
  if (
    parts.length > 2 ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(parts[0]) ||
    parts[0].includes("..") ||
    (parts[1] && !["stepcode", OFFICIAL_MARKETPLACE].includes(parts[1]))
  )
    throw new Error("无效的 StepCode 插件标识");
  return { name: parts[0], marketplace: parts[1] || "stepcode" };
}
export async function readOfficialCatalog(source = officialPluginSource()) {
  try {
    const catalog = JSON.parse(await readFile(join(source, "catalog.json"), "utf8"));
    if (
      catalog.format !== 1 ||
      !OFFICIAL_PLUGIN_NAMES.filter(name => !isUnavailableOfficialPlugin(name)).every((name) => catalog.plugins.some((p) => p.name === name))
    )
      throw new Error("原版内置插件清单不完整");
    return catalog.plugins;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export function ensureOfficialStepPlugins(root, source = officialPluginSource()) {
  const key = resolve(root) + "\0" + resolve(source);
  if (!seeds.has(key))
    seeds.set(
      key,
      withStepPluginState(root, () => materialize(root, source)).catch((error) => {
        seeds.delete(key);
        throw error;
      }),
    );
  return seeds.get(key);
}
async function materialize(root, source) {
  await retireMissingBundledPlugins(root);
  const catalog = await readOfficialCatalog(source);
  for (const entry of catalog) {
    const active = join(root, "plugins", entry.name),
      disabled = join(root, "disabled-plugins", entry.name);
    const current = await readStepPluginDeclaration(active);
    if (
      isUnavailableOfficialPlugin(entry.name) &&
      current?.enabled &&
      current.manifest.stepOfficial === true
    ) {
      await rename(join(active, "step.plugin.json"), join(active, STEP_PLUGIN_DISABLED_MANIFEST));
    }
    if (current) { await refreshBundledOfficeNotice(active, source, entry.name, current.manifest); continue; }
    const inactive = await readStepPluginDeclaration(disabled);
    if (inactive) { await refreshBundledOfficeNotice(disabled, source, entry.name, inactive.manifest); continue; }
    const original = join(source, entry.name),
      manifest = JSON.parse(await readFile(join(original, ".zcode-plugin/plugin.json"), "utf8"));
    const enabled = entry.defaultEnabled && !isUnavailableOfficialPlugin(entry.name);
    const destination = enabled ? active : disabled;
    await mkdir(dirname(destination), { recursive: true });
    await cp(original, destination, { recursive: true });
    // Step 的个人技能可能同名（computer-use 实测被个人 Orca 技能遮蔽）。
    // 只给 frontmatter 加稳定内置命名空间，目录与全部相对脚本路径保持原版。
    if (await exists(join(destination, "skills")))
      for (const skill of await readdir(join(destination, "skills"), { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        const file = join(destination, "skills", skill.name, "SKILL.md");
        if (await exists(file)) {
          const markdown = await readFile(file, "utf8");
          await writeFile(
            file,
            markdown.replace(
              /^name:\s*[^\r\n]+/m,
              `name: step-builtin-${entry.name}-${skill.name}`,
            ),
          );
        }
      }
    let servers = manifest.mcpServers ?? {};
    if (await exists(join(original, ".mcp.json")))
      servers = {
        ...servers,
        ...JSON.parse(await readFile(join(original, ".mcp.json"), "utf8")).mcpServers,
      };
    // Node Repl 是 browser/computer 的共用依赖，只由 browser-use 注册一次原宿主。
    if (entry.name === "browser-use")
      servers = { ...servers, node_repl: { type: "stdio", _nodeRepl: true } };
    const declaration = {
      id: entry.name,
      name: labels[entry.name] ?? entry.name,
      version: entry.version,
      description: manifest.description_i18n?.["zh-CN"] ?? entry.description,
      marketplace: OFFICIAL_MARKETPLACE,
      stepOfficial: true,
      skills: (await exists(join(destination, "skills"))) ? ["skills"] : [],
      commands: (await exists(join(destination, "commands"))) ? ["commands"] : [],
      agents: (await exists(join(destination, "agents"))) ? ["agents"] : [],
      userConfig: manifest.userConfig,
      mcpServers: Object.fromEntries(
        Object.keys(servers).map((name) => [
          name,
          {
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../bin/official-plugin-mcp.mjs", import.meta.url)),
              "--plugin-root",
              destination,
              "--mcp-name",
              name,
            ],
            env: { STEPCODE_STORAGE_ROOT_DIR: root },
            timeoutMs: servers[name].timeoutMs ?? (entry.name === "android-emulator" ? 1200000 : 600000),
          },
        ]),
      ),
    };
    await writeFile(
      join(destination, "step-official-runtime.json"),
      JSON.stringify(
        { plugin: entry.name, servers, userConfig: manifest.userConfig ?? {}, sourceRoot: source },
        null,
        2,
      ),
    );
    await writeFile(join(destination, "step.plugin.json"), JSON.stringify(declaration, null, 2));
  }
  return catalog;
}
export async function officialPluginComponents(root, manifest) {
  const groups = [];
  for (const [kind, directory] of [
    ["skill", "skills"],
    ["command", "commands"],
    ["agent", "agents"],
  ]) {
    let items = [];
    try {
      const entries = await readdir(join(root, directory), { withFileTypes: true });
      items = entries
        .filter((e) => (kind === "skill" ? e.isDirectory() : e.isFile() && e.name.endsWith(".md")))
        .map((e) => ({ name: e.name.replace(/\.md$/, "") }));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (items.length) groups.push({ kind, items });
  }
  const mcp = Object.keys(manifest.mcpServers ?? {});
  if (mcp.length) groups.push({ kind: "mcp", items: mcp.map((name) => ({ name })) });
  return groups;
}
/** Browser Use 与 Computer Use 共用一个宿主；关闭一项不能切断另一项或重复注册。 */
export async function syncOfficialNodeHost(root) {
  return withStepPluginState(root, () => syncOfficialNodeHostLocked(root));
}

async function syncOfficialNodeHostLocked(root) {
  const browser = join(root, "plugins/browser-use"),
    computer = join(root, "plugins/computer-use");
  const isOfficial = async (path) =>
    (await exists(join(path, "step.plugin.json"))) &&
    JSON.parse(await readFile(join(path, "step.plugin.json"), "utf8")).stepOfficial === true;
  const browserEnabled = await isOfficial(browser),
    computerEnabled = await isOfficial(computer);
  for (const [path, owner] of [
    [browser, browserEnabled],
    [computer, !browserEnabled && computerEnabled],
  ]) {
    if (!(await exists(join(path, "step.plugin.json")))) continue;
    const file = join(path, "step.plugin.json"),
      manifest = JSON.parse(await readFile(file, "utf8"));
    // 同名用户插件没有本适配器运行清单，不能接管其 MCP 或阻断会话启动。
    if (manifest.stepOfficial !== true) continue;
    const runtimeFile = join(path, "step-official-runtime.json"),
      runtime = JSON.parse(await readFile(runtimeFile, "utf8"));
    const previousServers = JSON.stringify(manifest.mcpServers ?? {}),
      previousRuntimeServers = JSON.stringify(runtime.servers ?? {});
    if (owner) {
      runtime.servers.node_repl = { type: "stdio", _nodeRepl: true };
      manifest.mcpServers.node_repl = {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../bin/official-plugin-mcp.mjs", import.meta.url)),
          "--plugin-root",
          path,
          "--mcp-name",
          "node_repl",
        ],
        env: { STEPCODE_STORAGE_ROOT_DIR: root },
        timeoutMs: 600000,
      };
    } else {
      delete manifest.mcpServers.node_repl;
      delete runtime.servers.node_repl;
    }
    // 只写自身拥有且确实变更的 MCP 字段；共享锁覆盖整个读取/变更，保留并发技能选择。
    if (JSON.stringify(manifest.mcpServers ?? {}) !== previousServers)
      await writeStepPluginState(file, JSON.stringify(manifest, null, 2));
    if (JSON.stringify(runtime.servers ?? {}) !== previousRuntimeServers)
      await writeStepPluginState(runtimeFile, JSON.stringify(runtime, null, 2));
  }
}
