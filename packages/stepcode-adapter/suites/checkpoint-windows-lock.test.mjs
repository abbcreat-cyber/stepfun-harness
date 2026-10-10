import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readImage, putImage } from "../src/file-checkpoints.mjs";

for (const change of [false, true]) test(`Windows 短暂共享锁：${change ? "外部修改不能被覆盖" : "释放后可恢复"}`, { skip: process.platform !== "win32", timeout: 10000 }, async () => {
  const base = process.env.STEP_TEST_ROOT || "D:/Temp/stepcode-history-tests";
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, "locked-"));
  const path = join(root, "file.txt"); await writeFile(path, "before"); const before = await readImage(path);
  await writeFile(path, "after"); const after = await readImage(path);
  const script = join(root, "lock.ps1");
  await writeFile(script, 'param([string]$Target,[string]$Change)\n$f=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)\ntry { [Console]::WriteLine("LOCKED"); Start-Sleep -Milliseconds 100; if($Change -eq "yes") { $bytes=[Text.Encoding]::UTF8.GetBytes("external");$f.Position=0;$f.Write($bytes,0,$bytes.Length);$f.SetLength($bytes.Length);$f.Flush() };Start-Sleep -Milliseconds 100 } finally {$f.Dispose()}\n');
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Target", path, "-Change", change ? "yes" : "no"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("lock fixture did not start")), 5000); child.once("error", reject); child.stdout.on("data", bytes => { if (String(bytes).includes("LOCKED")) { clearTimeout(timer); resolve(); } }); });
    if (change) await assert.rejects(putImage(path, before, after.hash), /发生变化/);
    else await putImage(path, before, after.hash);
    await exited;
    assert.equal(await readFile(path, "utf8"), change ? "external" : "before");
  } finally { if (child.exitCode === null) child.kill(); await exited; }
});
