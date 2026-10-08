import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopPluginReferenceContext } from "../src/desktop-plugin-context.mjs";

test("explicit plugin reference uses current Step declaration and actual SDK loaded skills", async t => {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || "D:/Temp/stepfun-harness-tests", "plugin-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugins/pdf");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "step.plugin.json"), JSON.stringify({ id: "pdf", name: "PDF", stepOfficial: true, skills: ["skills"] }));
  const skills = [
    { name: "pdf", filePath: join(directory, "skills/pdf/SKILL.md") },
    { name: "foreign", filePath: join(root, "plugins/pdf-other/skills/pdf/SKILL.md") },
  ];
  const prompt = "[@PDF](plugin://pdf@zcode-plugins-official) 打开";
  const context = await desktopPluginReferenceContext(prompt, skills, root);
  assert.ok(context.includes('"installed":true'));
  assert.ok(context.includes('"loaded":true'));
  assert.ok(!context.includes("foreign"));
  assert.ok(context.includes("询问具体目标"));
  const skillDir = join(directory, "skills/pdf");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: pdf\n---\nORIGINAL_PDF_INSTRUCTIONS");
  const activated = await desktopPluginReferenceContext(prompt, [...skills, skills[0]], root, { activateSkills: true });
  assert.equal(activated.split("ORIGINAL_PDF_INSTRUCTIONS").length - 1, 1, "explicit plugin must activate original skill exactly once");
  assert.ok(activated.includes(JSON.stringify(skillDir)));
  assert.ok(!context.includes("ORIGINAL_PDF_INSTRUCTIONS"), "discovery facts alone do not expand skill bodies");
  await rename(join(directory, "step.plugin.json"), join(directory, "step.plugin.disabled.json"));
  const disabled = await desktopPluginReferenceContext(prompt, [], root);
  assert.ok(disabled.includes('"enabled":false'));
  assert.ok(disabled.includes('"loaded":false'));
  assert.ok(!disabled.includes("SKILL.md"), "disabled skills cannot be presented as usable");
  assert.ok(!(await desktopPluginReferenceContext(prompt, skills, root, { activateSkills: true })).includes("ORIGINAL_PDF_INSTRUCTIONS"));
  const lateDisable = await desktopPluginReferenceContext(prompt, skills, root);
  assert.ok(lateDisable.includes('"enabled":false') && lateDisable.includes('"loaded":true'), "current SDK snapshot and later declaration change remain distinct facts");
  const wrongMarket = await desktopPluginReferenceContext("plugin://pdf@stepcode", skills, root);
  assert.ok(wrongMarket.includes('"installed":false'));
  assert.equal(await desktopPluginReferenceContext("你好", skills, root), "");
  assert.equal(await desktopPluginReferenceContext("plugin://../../outside", skills, root), "");
  assert.equal(await desktopPluginReferenceContext(prompt, skills, undefined), "");
  const mcp = join(root, "plugins/browser");
  await mkdir(mcp);
  await writeFile(join(mcp, "step.plugin.json"), JSON.stringify({ id: "browser", skills: [], mcpServers: { browser: {} } }));
  const mcpContext = await desktopPluginReferenceContext("plugin://browser@stepcode", [], root);
  assert.ok(mcpContext.includes('"mcpServerNames":["browser"]'));
  assert.ok(!mcpContext.includes('"loaded":false'), "no skill file does not imply disconnected MCP tools");
  await writeFile(join(mcp, "step.plugin.json"), "NOT_JSON");
  assert.ok((await desktopPluginReferenceContext("plugin://browser@stepcode", [], root)).includes('"status":"unavailable"'));
});
