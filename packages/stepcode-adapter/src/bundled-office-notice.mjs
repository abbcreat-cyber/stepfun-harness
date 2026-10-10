import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const skills = { pdf: "pdf", documents: "docx", spreadsheets: "xlsx", presentations: "pptx" };
export const LEGACY_OFFICE_NOTICE = "In the Windows desktop app, document tools are bundled. Probe `soffice --version` before installing anything. The provided `soffice` / `libreoffice` commands support ordinary headless conversions through a compact native LibreOffice engine. `HARNESS_OFFICE_CLI` points to its Node CLI, which also provides `recalculate INPUT [OUTPUT]` and `render INPUT NEW_DIRECTORY`. The spreadsheet helper automatically uses it for formula recalculation. Keep using the document quality checks below. If a bundled command fails, report its actual error; do not replace or reinstall the runtime silently.";

/** 升级只迁移已知的旧环境说明，不覆盖技能正文、用户编辑或启用状态。 */
export async function refreshBundledOfficeNotice(destination, source, id, manifest) {
  if (!skills[id] || manifest?.stepOfficial !== true) return false;
  const suffix = ["skills", skills[id], "SKILL.md"];
  try {
    const path = join(destination, ...suffix), current = await readFile(path, "utf8");
    if (!current.includes(LEGACY_OFFICE_NOTICE)) return false;
    const bundled = await readFile(join(source, id, ...suffix), "utf8");
    const start = bundled.indexOf("<!-- harness-office-capabilities:v2 -->");
    const end = bundled.indexOf("<!-- /harness-office-capabilities -->", start);
    if (start < 0 || end < 0) return false;
    const replacement = bundled.slice(start, end + "<!-- /harness-office-capabilities -->".length);
    await writeFile(path, current.replace(LEGACY_OFFICE_NOTICE, replacement));
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
