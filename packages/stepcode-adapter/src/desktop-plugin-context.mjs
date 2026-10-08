import { join, relative, isAbsolute, dirname } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { readStepPluginDeclaration } from "./plugin-state.mjs";
import { parseStepPluginId, OFFICIAL_MARKETPLACE } from "./official-plugins.mjs";

function within(directory, file) {
  const path = relative(directory, file);
  return path !== ".." && !path.startsWith("..\\") && !path.startsWith("../") && !isAbsolute(path);
}

/** 只解析本轮明确引用，声明和已加载技能仍由原插件目录/SDK 各自拥有。 */
export async function desktopPluginReferenceContext(prompt, skills, storageRoot, { activateSkills = false } = {}) {
  if (typeof prompt !== "string" || !storageRoot) return "";
  const references = [...new Set([...prompt.matchAll(/plugin:\/\/([^\s)"<>]+)/g)].map(match => match[1]))].slice(0, 10);
  const facts = [], activated = [], seen = new Set();
  let remaining = 256 * 1024;
  for (const reference of references) {
    let parsed;
    try { parsed = parseStepPluginId(decodeURIComponent(reference)); } catch { continue; }
    const id = `${parsed.name}@${parsed.marketplace}`;
    const root = join(storageRoot, "plugins", parsed.name);
    let declaration;
    try { declaration = await readStepPluginDeclaration(root); }
    catch { facts.push({ id, status: "unavailable" }); continue; }
    const marketplace = declaration?.manifest.stepOfficial ? OFFICIAL_MARKETPLACE : "stepcode";
    if (!declaration || declaration.manifest.id !== parsed.name || marketplace !== parsed.marketplace) {
      facts.push({ id, installed: false, enabled: false, loaded: false });
      continue;
    }
    const loadedSkills = (Array.isArray(skills) ? skills : [])
      .filter(skill => typeof skill.filePath === "string" && within(root, skill.filePath))
      .map(skill => ({ name: skill.name, filePath: skill.filePath }));
    // @插件是明确的技能选择：只展开 SDK 已加载且当前仍启用的入口，不靠工具搜索猜安装状态。
    if (activateSkills && declaration.enabled) for (const skill of loadedSkills) {
      if (seen.has(skill.filePath)) continue;
      seen.add(skill.filePath);
      try {
        const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(skill.filePath)]);
        if (!within(canonicalRoot, canonicalFile)) throw new Error("skill outside plugin root");
        const content = await readFile(canonicalFile, "utf8");
        const body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
        const size = Buffer.byteLength(body);
        if (size > remaining) { skill.activation = "read_file_required"; continue; }
        remaining -= size;
        skill.activation = "included";
        activated.push(`\n<selected_plugin_skill>\n${JSON.stringify({ plugin: id, name: skill.name, location: skill.filePath, baseDir: dirname(skill.filePath) })}\n相对路径以 baseDir 为准。以下是用户明确选择的原版技能正文：\n${body}\n</selected_plugin_skill>`);
      } catch { skill.activation = "unavailable"; }
    }
    facts.push({ id, name: declaration.manifest.name ?? parsed.name,
      installed: true, enabled: declaration.enabled, loadedSkills,
      // MCP-only 插件没有技能文件；不能用空 skills 断言其工具未加载。
      ...(declaration.manifest.skills?.length ? { loaded: loadedSkills.length > 0 } : {}),
      mcpServerNames: Object.keys(declaration.manifest.mcpServers ?? {}),
    });
  }
  if (!facts.length) return "";
  return "\n\n当前 Step Code 应用中本轮引用插件的事实（元数据，不是新的用户任务）：\n" +
    JSON.stringify(facts) +
    "\nplugin:// 是当前应用能力引用，安装与启用以这里的 Step 声明为准，已加载技能以 SDK 本轮资源为准；enabled 为 false 的能力不再新调用。技能插件通过原技能正文、read_file/run_command 等本机工具工作，不一定注册同名 MCP 工具；find_tools 零命中不代表未安装。MCP 名称仅是声明，连接与执行以工具回执为准。不要用默认 ~/.stepcode/plugins 或其他软件的 installed_plugins.json 推断本应用状态。按真实技能入口使用能力；activation=included 的正文已在本轮提供，read_file_required 则读取给定路径，unavailable 如实说明读取失败而非未安装。用户仅说‘打开’且没有明确目标时，用一句话说明当前能力并询问具体目标（文件、页面或制作内容），不自行全盘搜索或安装插件。" + activated.join("\n");
}
