import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const legacyFiles = [
  ["scripts/browser-client.mjs", ["615d4ed297b114b70056f4e1788f499d959cbcd81f3bbc91fb96eac0b0d53c9e", "0e08c198a95141eed8dd66a4cc83dc8e70efc6e44782977cafb53beb79d28fa7", "196262236ed70e4c77a6f7a23a45faaf5330002bd95617a3809f5fb653f2c5a3"]],
  ["docs/api.json", ["8edf6e170b888506c52ea23fe6af7d1534496e70bc10137b12f05debfe01a8aa"]],
  ["docs/playwright.md", ["2e41a4f52e321318c3e21cdbbf09d93365d1866c49960496484dcaa158c8aa5c"]],
];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const legacyGuidanceHash = "376621aaabfec905b2b8de4f500bc4bea7c131866c42d1958546eaf1777c8ddb";
const guidancePath = "skills/control-browser/SKILL.md";
function guidanceHash(text) {
  return hash(text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").replace(/^name:[^\n]*/m, "name: control-browser"));
}
/** 只替换已核对的旧官方浏览器封装，不覆盖用户修改或其他插件。 */
export async function refreshBundledBrowserClient(destination, source, id, manifest) {
  if (id !== "browser-use" || manifest?.stepOfficial !== true) return false;
  let temp, changed = false;
  try {
    const client = await readFile(join(destination, legacyFiles[0][0]));
    if (!legacyFiles[0][1].includes(hash(client))) {
      const bundled = await readFile(join(source, id, legacyFiles[0][0]));
      if (!client.equals(bundled)) return false;
    }
    const skillFile = join(destination, guidancePath);
    const skill = await readFile(skillFile, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (skill !== null && guidanceHash(skill) === legacyGuidanceHash) {
      // 旧安装的只读初始化被拆成多个模型往返；仅迁移已知原版，保留用户编辑和技能命名空间。
      const bundled = await readFile(join(source, id, guidancePath), "utf8");
      const name = skill.match(/^name:[^\r\n]*/m)?.[0] ?? "name: control-browser";
      const replacement = bundled.replace(/^name:[^\r\n]*/m, () => name);
      if (skill !== replacement) {
        temp = `${skillFile}.${randomUUID()}.tmp`;
        await writeFile(temp, replacement);
        await rename(temp, skillFile); temp = undefined; changed = true;
      }
    }
    for (const [relative, previousHashes] of legacyFiles) {
      const file = join(destination, relative);
      const current = await readFile(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (!current || !previousHashes.includes(hash(current))) continue;
      const replacement = await readFile(join(source, id, relative));
      if (current.equals(replacement)) continue;
      temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, replacement);
      await rename(temp, file); temp = undefined; changed = true;
    }
    return changed;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  finally { if (temp) await unlink(temp).catch(() => {}); }
}
