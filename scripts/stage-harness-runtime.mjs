import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { deployAdapter } from "./deploy-harness-adapter.mjs";

// 输入清单由构建者提供，绝不把构建者机器路径写入发布包。
const config = JSON.parse(await readFile(resolve(process.argv[2]), "utf8"));
const root = resolve("packages/desktop/build/harness-runtime");
await mkdir(root, { recursive: true });
const copy = async (src, dest) => cp(src, join(root, dest), { recursive: true, dereference: true,
  filter: path => !["__pycache__", ".git", "_virtualenv.py", "_virtualenv.pth", "direct_url.json"].includes(basename(path)) && !path.endsWith(".pyc") });
await copy(config.node, "node/node.exe");
if (config.nodeDirectory) await copy(config.nodeDirectory, "node");
await copy(config.nodeLicense, "node/LICENSE");
await copy(config.step, "step");
await copy(config.stepLicense, "step/LICENSE");
await copy(config.git, "git");
await copy(config.documentNode, "tools/document-node");
await copy(config.libreOffice, "tools/LibreOffice25.8.4.2/SourceDir/LibreOffice");
await copy(config.pythonEmbed, "tools/document-python/Scripts");
await copy(config.pythonPackages, "tools/document-python/Lib/site-packages");
const scripts = join(root, "tools/document-python/Scripts");
const pth = (await readdir(scripts)).find(name => /^python\d+\._pth$/.test(name));
if (!pth) throw new Error("Expected an official Windows embedded Python distribution");
await writeFile(join(scripts, pth), `${pth.replace("._pth", ".zip")}\n.\n../Lib/site-packages\nimport site\n`);
await deployAdapter(resolve("packages/stepcode-adapter"), join(root, "adapter"));
const stepVersion = execFileSync(join(root, "step/step.exe"), ["--version"], { encoding: "utf8", windowsHide: true }).trim().replace(/^v/, "");
const hash = async file => createHash("sha256").update(await readFile(join(root, file))).digest("hex");
await writeFile(join(root, "manifest.json"), JSON.stringify({ schema: 1, stepVersion,
  nodeVersion: execFileSync(join(root, "node/node.exe"), ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
  hashes: Object.fromEntries(await Promise.all(["node/node.exe", "step/step.exe", "git/bin/bash.exe", "tools/document-python/Scripts/python.exe"].map(async file => [file, await hash(file)]))),
}, null, 2));
await cp(resolve("LICENSES.md"), join(root, "LICENSES.md"));
console.log("Self-contained runtime staged");
