import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { includeRuntimePath } from "./runtime-copy-policy.mjs";
import { parseOfficeArgs, runOffice } from "../tools/office/office.mjs";

const exec = promisify(execFile);
test("Office help exposes supported input pairs instead of suggesting full LibreOffice compatibility", async () => {
  const lines = [];
  await runOffice(["--help"], undefined, line => lines.push(line));
  assert.match(lines.join("\n"), /doc\/docx\/odt/);
  assert.match(lines.join("\n"), /ReportLab/);
});
test("copy policy keeps runtime compiler data and license sources, omits development files", () => {
  const root = resolve("example-package");
  for (const file of ["lib/api.mjs", "src/node.ts", "typescript/lib/lib.es2025.d.ts", "licenses/LICENSE", "sources/tests/original.c", "data/cp936.json"]) assert.ok(includeRuntimePath(root, join(root, file)), file);
  for (const file of ["tests/example.js", "suites/test.mjs", "dist/main.js.map", "__pycache__/test.pyc"]) assert.ok(!includeRuntimePath(root, join(root, file)), file);
});
test("Office argument admission accepts documented compatibility flags and rejects unsupported options", () => {
  const parsed = parseOfficeArgs(["--headless", "-env:UserInstallation=file:///test", "--convert-to", "pdf:writer_pdf_Export", "--outdir", "output", "中文 name.docx"]);
  assert.equal(parsed.format, "pdf"); assert.equal(parsed.files.length, 1);
  assert.throws(() => parseOfficeArgs(["--convert-to"]), /Missing value/);
  assert.throws(() => parseOfficeArgs(["--convert-to", "pdf:writer_pdf_Export:unsupported", "a.docx"]), /Unsupported/);
  assert.throws(() => parseOfficeArgs(["--unknown", "a.docx"]), /Unsupported/);
});

const runtime = process.env.HARNESS_OFFICE_TEST_RUNTIME;
test("relocatable bundled Office preserves document capabilities and failure semantics", { skip: !runtime, timeout: 240000 }, async () => {
  const root = resolve(".release-check", "office-" + Date.now()); await mkdir(root, { recursive: true });
  const python = join(runtime, "tools/document-python/Scripts/python.exe"), office = join(runtime, "tools/office/bin/soffice.exe");
  const env = { ...process.env, PATH: `${join(runtime, "node")};${join(runtime, "tools/office/bin")};C:/Windows/System32;C:/Windows`,
    HARNESS_OFFICE_CLI: join(runtime, "tools/office/office.mjs"), STEPCODE_NODE: join(runtime, "node/node.exe"),
    PYTHONNOUSERSITE: "1", PYTHONPATH: "", PYTHONHOME: "", PYTHONIOENCODING: "utf-8" };
  const run = (file, args, timeout = 90000) => exec(file, args, { env, windowsHide: true, timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.match((await run(office, ["--version"])).stdout, /LibreOffice kit/);
  await run(python, [resolve("tools/office/fixtures.py"), root]);
  const outputs = join(root, "pdf"); await mkdir(outputs);
  await run(office, ["--headless", "--convert-to", "pdf", "--outdir", outputs, join(root, "中文 文档.docx"), join(root, "中文 演示.pptx"), join(root, "中文 表格.xlsx")]);
  const recalc = resolve("vendor/step-official-plugins/spreadsheets/skills/xlsx/xlsx.py");
  const report = await run(python, [recalc, "recalc", join(root, "中文 表格.xlsx"), "60"]);
  assert.ok(!report.stdout.includes('"error":'), report.stdout);
  await run(python, ["-c", "import sys;from openpyxl import load_workbook;p=sys.argv[1];a=load_workbook(p,data_only=True);b=load_workbook(p);assert a.active['C4'].value==85;assert a.active['D2'].value=='通过';assert b.active['C4'].value=='=SUM(C2:C3)'", join(root, "中文 表格.xlsx")]);
  const errors = await run(python, [recalc, "recalc", join(root, "公式错误.xlsx"), "60"]).catch(error => { if (error.code !== 1) throw error; return error; }); assert.ok(errors.stdout.includes("#DIV/0!"), errors.stdout);
  await run(python, ["-c", "import sys;from pathlib import Path;from pypdf import PdfReader;p=Path(sys.argv[1]);d=PdfReader(p/'中文 文档.pdf');s=PdfReader(p/'中文 演示.pdf');assert len(d.pages)==1;assert len(s.pages)==3;assert 'HARNESS_DOCUMENT_MARKER' in d.pages[0].extract_text();assert '中文排版' in d.pages[0].extract_text();assert 'HARNESS_PRESENTATION_MARKER' in s.pages[0].extract_text()", outputs]);
  await run(office, ["render", join(outputs, "中文 文档.pdf"), join(root, "previews"), "--dpi", "96"]);
  assert.ok((await readdir(join(root, "previews"))).some(name => name.endsWith(".png")));
  const csv = join(root, "数据.csv"); await writeFile(csv, '项目,数量\n文档,2\n"=SUM(1,2)",3\n');
  await run(office, ["convert", csv, join(root, "数据.xlsx")]);
  await run(python, ["-c", "import sys;from openpyxl import load_workbook;w=load_workbook(sys.argv[1]);assert w.active['A2'].value=='文档';assert w.active['A3'].data_type=='s'", join(root, "数据.xlsx")]);
  const preserved = join(root, "preserved.pdf"); await writeFile(preserved, "ORIGINAL");
  const bad = join(root, "bad.docx"); await writeFile(bad, "invalid");
  await assert.rejects(run(office, ["convert", bad, preserved])); assert.equal(await readFile(preserved, "utf8"), "ORIGINAL");
  await assert.rejects(run(office, ["convert", join(root, "中文 文档.docx"), preserved, "--timeout-ms", "1"]));
  assert.equal(await readFile(preserved, "utf8"), "ORIGINAL");
  const child = spawn(office, ["convert", join(root, "中文 演示.pptx"), preserved], { env, windowsHide: true, stdio: "ignore" });
  await new Promise((done, fail) => { child.once("error", fail); child.once("spawn", () => setTimeout(() => child.kill(), 50)); child.once("exit", done); });
  assert.equal(await readFile(preserved, "utf8"), "ORIGINAL");
  await writeFile(join(root, "result.json"), JSON.stringify({ pass: true, pdfs: ["中文 文档.pdf", "中文 演示.pdf", "中文 表格.pdf"], tests: ["conversion", "Chinese text", "three-slide chart presentation", "formula cache and formulas", "formula error reporting", "PNG preview", "invalid input", "timeout", "cancellation"] }, null, 2));
  console.log(`Office acceptance artifacts: ${root}`);
});
