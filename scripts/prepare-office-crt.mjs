import { mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

// Extract app-local runtime DLLs from a Microsoft-signed redistributable, without installing it.
export async function prepareOfficeCrt(redist, target, workRoot, sevenZip) {
  const escaped = resolve(redist).replaceAll("'", "''");
  // 从 PowerShell 7 启动 Node 后再运行 Windows PowerShell 时，不能继承 Core 专用模块路径。
  const env = { ...process.env, PSModulePath: join(process.env.WINDIR || "C:/Windows", "System32/WindowsPowerShell/v1.0/Modules") };
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notlike '*O=Microsoft Corporation*'){throw 'A valid Microsoft redistributable signature is required'}`], { env, windowsHide: true, encoding: "utf8", stdio: "pipe" });
  const bytes = await readFile(redist), cabinets = [];
  await mkdir(workRoot, { recursive: true }); await mkdir(target, { recursive: true });
  for (let index = bytes.indexOf("MSCF"); index >= 0; index = bytes.indexOf("MSCF", index + 1)) {
    if (index + 36 > bytes.length || bytes.readUInt32LE(index + 4) !== 0) continue;
    const size = bytes.readUInt32LE(index + 8);
    if (size < 36 || index + size > bytes.length) continue;
    const archive = join(workRoot, `${index}.cab`), folder = join(workRoot, String(index));
    await writeFile(archive, bytes.subarray(index, index + size));
    execFileSync(sevenZip, ["x", archive, `-o${folder}`, "-y"], { windowsHide: true, stdio: "pipe" });
    cabinets.push(folder);
  }
  let manifest, manifestDir;
  for (const dir of cabinets) {
    try { const xml = await readFile(join(dir, "0"), "utf8"); if (xml.includes("BurnManifest")) { manifest = xml; manifestDir = dir; break; } } catch {}
  }
  if (!manifest) throw new Error("Microsoft bundle manifest was not found");
  const payloads = [...manifest.matchAll(/<Payload\b[^>]+>/g)].map(match => Object.fromEntries([...match[0].matchAll(/(\w+)="([^"]*)"/g)].map(value => [value[1], value[2]])));
  const minimum = payloads.find(item => /vcRuntimeMinimum_amd64\\cab1\.cab$/i.test(item.FilePath));
  const license = payloads.find(item => item.FilePath === "license.rtf");
  if (!minimum || !license || !/^a\d+$/.test(minimum.SourcePath)) throw new Error("Microsoft x64 runtime payload is missing");
  let runtimeCab;
  for (const folder of cabinets) { try { await readFile(join(folder, minimum.SourcePath)); runtimeCab = join(folder, minimum.SourcePath); break; } catch {} }
  if (!runtimeCab) throw new Error("Microsoft runtime cabinet is missing");
  const extracted = join(workRoot, "runtime-dlls");
  execFileSync(sevenZip, ["x", runtimeCab, `-o${extracted}`, "-y"], { windowsHide: true, stdio: "pipe" });
  const inventory = [];
  for (const name of await readdir(extracted)) {
    if (!name.endsWith(".dll_amd64")) continue;
    const file = await readFile(join(extracted, name));
    if (file.readUInt16LE(file.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error("Wrong C++ runtime architecture");
    const destination = name.replace(/_amd64$/, "");
    await writeFile(join(target, destination), file);
    inventory.push({ name: destination, sha256: createHash("sha256").update(file).digest("hex") });
  }
  if (!inventory.some(item => item.name === "msvcp140.dll") || !inventory.some(item => item.name === "vcruntime140.dll")) throw new Error("C++ runtime DLL set is incomplete");
  await copyFile(join(manifestDir, license.SourcePath), join(target, "MICROSOFT-VC-LICENSE.rtf"));
  await writeFile(join(target, "microsoft-runtime.json"), JSON.stringify({ source: "https://aka.ms/vs/17/release/vc_redist.x64.exe", archiveSha256: createHash("sha256").update(bytes).digest("hex"), files: inventory }, null, 2));
  return inventory;
}
