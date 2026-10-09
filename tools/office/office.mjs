import { mkdtemp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createConverter, discoverRuntime } from "@deepseek-ai/libreoffice-kit";

const optionsWithValue = new Set(["--outdir", "--convert-to", "--timeout-ms", "--dpi", "--sheet", "--range"]);
const ignored = new Set(["--headless", "--invisible", "--nologo", "--nodefault", "--norestore", "--nolockcheck"]);
export function parseOfficeArgs(args) {
  const options = {}, files = [];
  let mode = "convert", initialized = false;
  if (["convert", "recalculate", "render"].includes(args[0])) mode = args.shift();
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === "--version") return { mode: "version" };
    if (value === "--help" || value === "-h") return { mode: "help" };
    if (value === "--terminate_after_init") { initialized = true; continue; }
    if (ignored.has(value) || /^--?env:UserInstallation=/.test(value)) continue;
    if (optionsWithValue.has(value)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${value}`);
      options[value.slice(2)] = args[++i]; continue;
    }
    if (value.startsWith("vnd.sun.star.script:") || value.startsWith("macro:")) {
      if (!/Standard\.Module1\.RecalculateAndSave(?:\?|$)/.test(value)) throw new Error("This Office runtime supports formula recalculation, not arbitrary Basic macros.");
      mode = "recalculate"; continue;
    }
    if (value.startsWith("-")) throw new Error(`Unsupported Office option: ${value}`);
    files.push(resolve(value));
  }
  if (initialized && files.length === 0) return { mode: "version" };
  if (!files.length) throw new Error("No input document supplied");
  const timeout = Number(options["timeout-ms"] ?? 120000);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600000) throw new Error("timeout-ms must be between 1 and 600000");
  const format = options["convert-to"]?.split(":")[0].toLowerCase();
  if (options["convert-to"]?.includes(":")) {
    const parts = options["convert-to"].split(":");
    if (parts.length > 2 || !/^(writer_pdf_Export|calc_pdf_Export|impress_pdf_Export|Office Open XML Text|Calc MS Excel 2007 XML|Impress MS PowerPoint 2007 XML)$/.test(parts[1])) throw new Error("Unsupported export filter; use the bundled Office CLI options");
  }
  const outdir = options.outdir ? resolve(options.outdir) : undefined;
  return { mode, files, format, outdir, timeout, dpi: options.dpi ? Number(options.dpi) : 144, sheet: options.sheet, range: options.range };
}

export async function runOffice(argv, signal, report = console.log) {
  const args = parseOfficeArgs([...argv]);
  if (args.mode === "version") { report(`LibreOffice kit ${discoverRuntime().version} (StepFun Harness)`); return; }
  if (args.mode === "help") { report("soffice --headless --convert-to pdf --outdir DIR FILE...\noffice.mjs convert INPUT OUTPUT\noffice.mjs recalculate INPUT [OUTPUT]\noffice.mjs render INPUT NEW_DIRECTORY [--dpi 144]"); return; }
  const converter = await createConverter({ timeoutMs: args.timeout });
  try {
    if (args.mode === "render") {
      if (args.files.length !== 2) throw new Error("render requires an input and a new output directory");
      const rendered = await converter.renderImages({ inputPath: args.files[0], outputDir: args.files[1], dpi: args.dpi, sheet: args.sheet, range: args.range }, signal);
      report(JSON.stringify(rendered)); return;
    }
    const jobs = args.format
      ? args.files.map(input => ({ input, output: join(args.outdir ?? process.cwd(), basename(input, extname(input)) + "." + args.format) }))
      : [{ input: args.files[0], output: args.files[1] ?? (args.mode === "recalculate" ? args.files[0] : undefined) }];
    if (!args.format && args.files.length > 2) throw new Error("Expected one input and one output path");
    for (const { input, output } of jobs) {
      if (!output) throw new Error("Specify an output path or --convert-to format");
      signal?.throwIfAborted();
      await mkdir(dirname(output), { recursive: true });
      const temp = await mkdtemp(join(dirname(output), ".harness-office-"));
      const destination = join(temp, "output" + extname(output));
      try {
        let source = input;
        if (args.mode === "convert" && extname(input).toLowerCase() === ".csv") {
          const requireDocuments = createRequire(new URL("../document-node/package.json", import.meta.url));
          const xlsx = requireDocuments("xlsx");
          source = join(temp, "input.xlsx");
          // CSV 文本作为单元格内容导入，不把文本形式的公式当成可执行公式。
          const workbook = xlsx.read(await readFile(input, "utf8"), { type: "string", raw: true });
          for (const sheet of Object.values(workbook.Sheets)) for (const [key, cell] of Object.entries(sheet)) {
            if (!key.startsWith("!") && cell.f) { cell.v = "=" + cell.f; cell.t = "s"; delete cell.f; }
          }
          xlsx.writeFile(workbook, source);
        }
        const operation = args.mode === "recalculate" ? converter.recalculate.bind(converter) : converter.convert.bind(converter);
        const result = await operation({ inputPath: source, outputPath: destination, sheet: args.sheet }, signal);
        if ((await stat(destination)).size === 0) throw new Error("Office engine returned an empty document");
        signal?.throwIfAborted();
        // 引擎只写独占临时输出；成功后才替换目标，失败保留用户原文件。
        await rename(destination, output);
        report(JSON.stringify({ input, output, ...result }));
      } finally { await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    }
  } finally { await converter.dispose(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const event of ["SIGINT", "SIGTERM"]) process.once(event, () => controller.abort(new Error("Office operation cancelled")));
  runOffice(process.argv.slice(2), controller.signal).catch(error => { console.error(`Office: ${error.message}`); process.exitCode = 1; });
}
