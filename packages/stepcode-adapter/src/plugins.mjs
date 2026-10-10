import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isMissingBundledPlugin } from "./builtin-plugin-availability.mjs";
import {
  withStepPluginState,
  writeStepPluginState,
  readStepPluginDeclaration,
  STEP_PLUGIN_MANIFEST,
  STEP_PLUGIN_DISABLED_MANIFEST,
} from "./plugin-state.mjs";
import {
  ensureOfficialStepPlugins,
  parseStepPluginId,
  officialPluginComponents,
  syncOfficialNodeHost,
  isUnavailableOfficialPlugin,
  OFFICIAL_MARKETPLACE,
} from "./official-plugins.mjs";

export const STEP_BROWSER_PLUGIN_ID = "playwright@stepcode";
export function makeEmbeddedBrowserManifest(root) {
  return {
    id: "playwright",
    name: "内置浏览器",
    version: "1.0.0",
    description: "控制当前软件右侧的内置浏览器标签页，复用内置浏览器，不启动外部窗口。",
    mcpServers: {
      embedded_browser: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../bin/embedded-browser-mcp.mjs", import.meta.url)),
          "--bridge-dir",
          join(root, "browser-bridges"),
        ],
      },
    },
  };
}

/** 原生底座只读取启用声明；单文件切换不移动正在运行的 MCP cwd。 */
export function createStepPluginHandlers(
  root = process.env.STEPCODE_STORAGE_ROOT_DIR || join(homedir(), ".stepcode"),
  options = {},
) {
  const browserManifest = makeEmbeddedBrowserManifest(root);
  const activeRoot = join(root, "plugins"),
    disabledRoot = join(root, "disabled-plugins");
  const safeName = (id) => {
    return parseStepPluginId(id).name;
  };
  async function scan() {
    if (process.env.STEP_BACKEND === "stepcode-local" || options.officialSource) {
      await ensureOfficialStepPlugins(root, options.officialSource);
      await syncOfficialNodeHost(root);
    }
    const plugins = [],
      diagnostics = [];
    for (const [directory, enabled] of [
      [activeRoot, true],
      [disabledRoot, false],
    ]) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const path = join(directory, entry.name);
          const declaration = await readStepPluginDeclaration(path);
          if (!declaration) continue;
          const { manifest } = declaration;
          if (isMissingBundledPlugin(manifest)) continue;
          if (manifest.stepOfficial && isUnavailableOfficialPlugin(manifest.id)) continue;
          // 内部宿主由浏览器等能力管理；不能在用户目录暴露一个可独立停用的依赖开关。
          if (manifest.stepOfficial === true && manifest.id === "node-repl-host") continue;
          const marketplace = manifest.stepOfficial ? OFFICIAL_MARKETPLACE : "stepcode";
          const id = `${safeName(manifest.id)}@${marketplace}`;
          const mcp =
            typeof manifest.mcpServers === "object" && manifest.mcpServers
              ? Object.keys(manifest.mcpServers)
              : [];
          const components = manifest.stepOfficial
            ? await officialPluginComponents(path, manifest)
            : [{ kind: "mcp", items: mcp.map((name) => ({ name })) }];
          let configuredOptions;
          try {
            configuredOptions = JSON.parse(
              await readFile(join(path, "step-user-config.json"), "utf8"),
            );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          plugins.push({
            id,
            name: manifest.name ?? manifest.id,
            description: manifest.description,
            version: manifest.version,
            enabled: enabled && declaration.enabled,
            source: manifest.stepOfficial ? "builtin" : "local",
            marketplace,
            rootPath: path,
            skillRootCount: manifest.skills?.length ?? 0,
            commandRootCount: manifest.commands?.length ?? 0,
            mcpServerNames: mcp,
            components,
            ...(manifest.userConfig ? { userConfig: manifest.userConfig } : {}),
            ...(configuredOptions ? { configuredOptions } : {}),
            rootSource: "user",
          });
        } catch (error) {
          diagnostics.push({
            code: "step_plugin_manifest",
            message: `${entry.name}: ${error.message}`,
            severity: "warning",
          });
        }
      }
    }
    if (!plugins.some((p) => p.id === STEP_BROWSER_PLUGIN_ID))
      plugins.push({
        id: STEP_BROWSER_PLUGIN_ID,
        name: browserManifest.name,
        description: browserManifest.description,
        version: browserManifest.version,
        enabled: false,
        source: "builtin",
        marketplace: "stepcode",
        rootPath: join(activeRoot, "playwright"),
        skillRootCount: 0,
        commandRootCount: 0,
        mcpServerNames: ["embedded_browser"],
        components: [{ kind: "mcp", items: [{ name: "embedded_browser" }] }],
        packageStatus: "missing",
        rootSource: "user",
      });
    return { plugins, diagnostics };
  }
  async function setEnabled(params) {
    if (typeof params.enabled !== "boolean") throw new Error("插件开关必须为布尔值");
    const name = safeName(params.pluginId);
    let before = (await scan()).plugins.find((p) => safeName(p.id) === name);
    if (!before) throw new Error("找不到该 StepCode 插件");
    if (name === "ios-simulator" && process.platform !== "darwin" && params.enabled)
      throw new Error("iOS 模拟器只支持 macOS，当前 Windows 无法启用");
    if (name === "computer-use" && params.enabled)
      throw new Error("当前构建未提供 Computer Use 真实运行库，已按要求跳过");
    if (name === "restore-legacy-sessions" && params.enabled)
      throw new Error("原版恢复脚本未适配 Step 会话格式，已按要求跳过");
    await withStepPluginState(root, async () => {
      // scan 在锁外执行宿主同步；进入写锁后重新定位目录，避免并发开关沿用旧 rootPath。
      if (!before.packageStatus) {
        const current = await readStepPluginDeclaration(join(activeRoot, name));
        const legacy = current ? null : await readStepPluginDeclaration(join(disabledRoot, name));
        if (!current && !legacy) throw new Error("找不到该 StepCode 插件声明");
        before = {
          ...before,
          enabled: !!current?.enabled,
          rootPath: join(current ? activeRoot : disabledRoot, name),
          manifestFileName: (current ?? legacy).fileName,
        };
      }
      if (before.packageStatus === "missing" && params.enabled) {
        if (name !== "playwright") throw new Error("该插件尚未安装");
        const target = join(activeRoot, name);
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "step.plugin.json"), JSON.stringify(browserManifest, null, 2));
      } else if (!before.packageStatus && before.enabled !== params.enabled) {
        if (before.rootPath === join(disabledRoot, name)) {
          // 兼容旧版停用目录：仅首次启用迁入稳定根，后续启停不再移动资产。
          await mkdir(activeRoot, { recursive: true });
          if (before.marketplace === OFFICIAL_MARKETPLACE) {
            const moved = join(activeRoot, name),
              file = join(before.rootPath, before.manifestFileName),
              manifest = JSON.parse(await readFile(file, "utf8"));
            for (const server of Object.values(manifest.mcpServers ?? {})) {
              const index = server.args.indexOf("--plugin-root");
              if (index >= 0) server.args[index + 1] = moved;
            }
            await writeStepPluginState(file, JSON.stringify(manifest, null, 2));
          }
          await rename(before.rootPath, join(activeRoot, name));
          before.rootPath = join(activeRoot, name);
        }
        if (!params.enabled) {
          // SDK 还支持 Claude fallback；拒绝把仍可加载的双声明插件伪装成关闭成功。
          try {
            await readFile(join(before.rootPath, ".claude-plugin/plugin.json"));
            throw new Error("此插件含 Claude 备用声明，无法只停用 Step 声明");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        const targetFile = params.enabled ? STEP_PLUGIN_MANIFEST : STEP_PLUGIN_DISABLED_MANIFEST;
        if (before.manifestFileName !== targetFile)
          await rename(
            join(before.rootPath, before.manifestFileName),
            join(before.rootPath, targetFile),
          );
      }
    });
    const plugin = (await scan()).plugins.find((p) => safeName(p.id) === name);
    return { plugin, enabled: plugin.enabled };
  }
  async function catalog() {
    const { plugins } = await scan();
    return {
      authority: "workspace",
      plugins: plugins
        .filter((p) => !p.packageStatus)
        .map((p) => ({
          pluginId: p.id,
          name: p.name,
          marketplace: p.marketplace,
          description: p.description,
          enabled: p.enabled,
          conflictingPluginIds: [],
          skillQualifiedNames: (p.components ?? [])
            .filter((c) => c.kind === "skill")
            .flatMap((c) => c.items.map((i) => `${safeName(p.id)}:${i.name}`)),
          mcpServerNames: p.mcpServerNames,
          subagentNames: (p.components ?? [])
            .filter((c) => c.kind === "agent")
            .flatMap((c) => c.items.map((i) => i.name)),
        })),
    };
  }
  async function overview() {
    const { plugins, diagnostics } = await scan();
    return {
      marketplaces: [...new Set(plugins.map((p) => p.marketplace))].map((marketplace) => ({
        id: marketplace,
        name: marketplace === OFFICIAL_MARKETPLACE ? "原版内置插件" : "StepCode",
        source: { type: "local", path: root },
        pluginCount: plugins.filter((p) => p.marketplace === marketplace).length,
      })),
      availablePlugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        marketplace: p.marketplace,
        description: p.description,
        version: p.version,
        installed: !p.packageStatus,
        componentTypes: [...new Set((p.components ?? []).map((c) => c.kind))],
      })),
      installedPlugins: plugins
        .filter((p) => !p.packageStatus)
        .map((p) => ({
          id: p.id,
          name: p.name,
          marketplace: p.marketplace,
          description: p.description,
          version: p.version,
          enabled: p.enabled,
          scope: "user",
          installPath: p.rootPath,
        })),
      restorableBuiltins: [],
      diagnostics,
      capability: { supported: true },
    };
  }
  return {
    "plugins/list": scan,
    "plugins/referenceCatalog": catalog,
    "plugins/referenceCatalogWithCategory": catalog,
    "plugins/overview": overview,
    "plugins/marketplace/update": async (params = {}) => {
      // 前端刷新会先调用 update 再读 overview；本地来源应重新扫描，不能落入 method-not-found。
      const current = await overview();
      const marketplaces = params.marketplace
        ? current.marketplaces.filter(item => item.id === params.marketplace)
        : current.marketplaces;
      if (params.marketplace && marketplaces.length === 0) throw new Error("找不到该 Step Code 插件来源");
      return { marketplaces, ...(params.marketplace ? { marketplace: marketplaces[0] } : {}), diagnostics: current.diagnostics };
    },
    "plugins/setEnabled": setEnabled,
    "plugins/restoreBuiltin": async (p) => {
      if (parseStepPluginId(p.pluginId).marketplace !== OFFICIAL_MARKETPLACE)
        throw new Error("不是原版内置插件");
      await scan();
      return { pluginId: p.pluginId, diagnostics: [] };
    },
    "plugins/install": async (p) => {
      if (!p.dryRun) await setEnabled({ pluginId: p.pluginId ?? p.pluginName, enabled: true });
      return {
        installedPlugins: (await overview()).installedPlugins,
        dependencyClosure: [],
        diagnostics: [],
      };
    },
    "plugins/describe": async (p) => ({
      components:
        (await scan()).plugins.find((plugin) => plugin.id === p.pluginId)?.components ?? [],
      diagnostics: [],
    }),
    "plugins/configure": async (p) => {
      const plugin = (await scan()).plugins.find((item) => item.id === p.pluginId);
      if (!plugin) throw new Error("找不到插件");
      const current = plugin.configuredOptions ?? {};
      const values = { ...current, ...p.options };
      for (const key of p.clearOptionKeys ?? []) delete values[key];
      if (!p.dryRun)
        await writeFile(
          join(plugin.rootPath, "step-user-config.json"),
          JSON.stringify(values, null, 2),
        );
      return { pluginId: p.pluginId, diagnostics: [] };
    },
    "plugins/resetConfig": async (p) => {
      const plugin = (await scan()).plugins.find((item) => item.id === p.pluginId);
      if (!plugin) throw new Error("找不到插件");
      await writeFile(join(plugin.rootPath, "step-user-config.json"), "{}");
      return { pluginId: p.pluginId, diagnostics: [] };
    },
    "plugins/validate": async () => {
      // 同一次检查只扫描一遍；诊断与 ok 使用同一结果，后续请求仍重新读取。
      const { diagnostics } = await scan();
      return {
        ok: !diagnostics.some((d) => d.severity === "error"),
        diagnostics,
        compatibility: {
          runnable: ["mcp", "skill", "command", "zcode-node-repl"],
          diagnosticOnly: [],
          unsupported: [],
        },
      };
    },
  };
}
