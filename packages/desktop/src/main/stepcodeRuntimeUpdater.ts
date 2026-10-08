import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { promisify } from "node:util";
import type { UpdateStatePayload, UpdateCheckResultPayload } from "@zcode/shared";

const exec = promisify(execFile);
const RELEASE_ROOT = "https://static-openapi.stepfun.com/stepcode/";
const versionPattern = /^\d+\.\d+\.\d+$/;
type Release = { version: string; url: string; checksum: string };
type Pointer = { version: string; executable: string };

export function parseStepRelease(raw: unknown, current: string, arch = process.arch): Release | null {
  const manifest = raw as { version?: string; packages?: Record<string, string>; checksums?: Record<string, string> };
  if (!manifest || typeof manifest.version !== "string" || !versionPattern.test(manifest.version)) throw new Error("StepCode 更新清单版本无效");
  if (!versionPattern.test(current)) throw new Error("无法确认当前 StepCode 版本");
  const next = manifest.version.split(".").map(Number), prior = current.split(".").map(Number);
  const order = next.map((n, i) => n - prior[i]!).find(n => n !== 0) ?? 0;
  if (order <= 0) return null;
  const target = `windows-${arch}`;
  const url = manifest.packages?.[target], checksum = manifest.checksums?.[target];
  if (!url || !checksum || !/^[a-f\d]{64}$/i.test(checksum)) throw new Error("新版缺少 Windows 下载包或校验值");
  const parsed = new URL(url);
  if (parsed.origin !== new URL(RELEASE_ROOT).origin || !parsed.pathname.startsWith(`/stepcode/${manifest.version}/`) || !parsed.pathname.endsWith(".zip")) throw new Error("StepCode 下载来源不受信任");
  return { version: manifest.version, url, checksum: checksum.toLowerCase() };
}

export class StepcodeRuntimeUpdater {
  private release: Release | null = null;
  private staged: Pointer | null = null;
  private operation:
    | { kind: "check"; promise: Promise<UpdateCheckResultPayload> }
    | { kind: "download"; promise: Promise<void>; progress: string }
    | null = null;
  private controller: AbortController | null = null;
  private skipped: string | null = null;
  constructor(
    readonly root: string,
    readonly currentVersion: string,
    private readonly publish: (state: UpdateStatePayload) => void,
    private readonly log: (message: string) => void,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async check(options: { manual?: boolean } = {}): Promise<UpdateCheckResultPayload> {
    // 用户手动检查必须能找回刚才跳过的底座版本，且每次点击都有明确结果。
    if (options.manual) this.skipped = null;
    if (this.staged) return { kind: "ready", version: this.staged.version };
    if (this.operation?.kind === "check") return this.operation.promise;
    if (this.operation?.kind === "download") return {
      kind: "already-downloading", version: this.release!.version, progress: this.operation.progress,
    };
    this.publish({ kind: "checking", enabled: false });
    const operation = (async (): Promise<UpdateCheckResultPayload> => {
      const response = await this.fetcher(`${RELEASE_ROOT}latest.json`, { redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`StepCode 更新检查 HTTP ${response.status}`);
      this.release = parseStepRelease(await response.json(), this.currentVersion);
      if (this.release && this.release.version !== this.skipped) {
        this.available();
        return { kind: "available", version: this.release.version, releaseNotes: this.notes() };
      }
      this.publish({ kind: "idle", enabled: true });
      return { kind: "up-to-date", currentVersion: this.currentVersion };
    })();
    this.operation = { kind: "check", promise: operation };
    try { return await operation; }
    catch (error) { this.publish({ kind: "idle", enabled: true }); throw error; }
    finally { this.operation = null; }
  }

  private notes() {
    const version = this.release!.version;
    return { version, title: `StepCode 底座 ${version}`,
      markdown: `将 StepCode 底座从 ${this.currentVersion} 更新至 ${version}。\n\n桌面界面、会话和 API 配置保持不变。下载包通过官方 SHA-256 校验后才可安装；失败保留原底座。` };
  }
  private available() {
    if (this.release) this.publish({ kind: "update-available", enabled: true, version: this.release.version, releaseNotes: this.notes() });
  }
  skip(version: string) { this.skipped = version; this.publish({ kind: "idle", enabled: true }); }
  cancel() { this.controller?.abort(); }

  async download(): Promise<void> {
    if (this.operation?.kind === "download") return this.operation.promise;
    if (this.operation?.kind === "check") await this.operation.promise;
    if (!this.release) throw new Error("没有可下载的 StepCode 更新");
    const release = this.release;
    this.controller = new AbortController();
    const operation = (async () => {
      const signal = AbortSignal.any([this.controller!.signal, AbortSignal.timeout(300000)]);
      const response = await this.fetcher(release.url, { redirect: "error", signal });
      if (!response.ok || !response.body) throw new Error(`StepCode 下载 HTTP ${response.status}`);
      const total = Number(response.headers.get("content-length")) || 0;
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let received = 0, lastBucket = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > 512 * 1024 * 1024) { await reader.cancel(); throw new Error("StepCode 下载包超出大小限制"); }
        chunks.push(value);
        const percent = total ? Math.min(99, Math.floor(received / total * 100)) : 0;
        if (percent !== lastBucket) {
          lastBucket = percent;
          if (this.operation?.kind === "download") this.operation.progress = `${percent}%`;
          this.publish({ kind: "download-progress", enabled: true, version: release.version,
            progress: `${percent}%`, transferredBytes: received, totalBytes: total, releaseNotes: this.notes() });
        }
      }
      const bytes = Buffer.concat(chunks);
      if (createHash("sha256").update(bytes).digest("hex") !== release.checksum) throw new Error("StepCode 下载包校验失败，保留原版本");
      const stage = join(this.root, `version-${release.version}`);
      await mkdir(stage, { recursive: true });
      const archive = join(stage, "release.zip"), extracted = join(stage, "files");
      await writeFile(archive, bytes);
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extracted)} -Force`], { windowsHide: true, timeout: 120000 });
      const executable = await findBinary(extracted);
      if (!executable) throw new Error("更新包缺少 step.exe");
      const verified = await exec(executable, ["--version"], { windowsHide: true, timeout: 20000 });
      if (verified.stdout.trim().replace(/^v/, "") !== release.version) throw new Error("新底座版本验证失败");
      await verifyStepRpc(executable);
      if (signal.aborted) throw new Error("已取消 StepCode 更新");
      this.staged = { version: release.version, executable };
      this.publish({ kind: "update-downloaded", enabled: true, version: release.version, releaseNotes: this.notes() });
    })();
    this.operation = { kind: "download", promise: operation, progress: "0%" };
    try { await operation; }
    catch (error) { this.available(); this.log(error instanceof Error ? error.message : String(error)); throw error; }
    finally { this.operation = null; this.controller = null; }
  }

  async activate(): Promise<void> {
    if (!this.staged) throw new Error("StepCode 尚未下载并验证完成");
    const path = relative(resolve(this.root), resolve(this.staged.executable));
    if (path.startsWith("..") || !path) throw new Error("底座路径不在版本目录内");
    const current = join(this.root, "current.json");
    try { await writeFile(join(this.root, "previous.json"), await readFile(current)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temp = join(this.root, `current-${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(this.staged));
    await rename(temp, current);
  }
}

export async function verifyStepRpc(executable: string): Promise<void> {
  await new Promise<void>((resolveCheck, rejectCheck) => {
    const child = spawn(executable, ["--mode", "rpc"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.stdin.end(); child.kill();
      if (error) rejectCheck(error); else resolveCheck();
    };
    const timer = setTimeout(() => finish(new Error("新底座 RPC 兼容性检查超时，保留原版本")), 30000);
    child.on("error", () => finish(new Error("新底座无法启动")));
    child.on("exit", () => { if (!settled) finish(new Error("新底座 RPC 意外退出")); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return finish(new Error("新底座 RPC 响应异常"));
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const frame = JSON.parse(line) as { id?: string; type?: string; success?: boolean; command?: string };
          if (frame.id === "desktop-update-probe") finish(frame.type === "response" && frame.command === "get_state" && frame.success ? undefined : new Error("新版不兼容当前 RPC 桥接"));
        } catch { /* 原生进程可在协议就绪前输出启动诊断。 */ }
      }
    });
    child.stdin.on("error", () => finish(new Error("新底座 RPC 输入不可用")));
    child.stdin.write(`${JSON.stringify({ id: "desktop-update-probe", type: "get_state" })}\n`);
  });
}

async function findBinary(root: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === "step.exe") return path;
    if (entry.isDirectory()) { const found = await findBinary(path); if (found) return found; }
  }
  return null;
}
