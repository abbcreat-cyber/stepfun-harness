import { CancellationToken, type AppUpdater, type UpdateInfo } from "electron-updater";
import { gunzipSync } from "node:zlib";
import { probeInstallerConnection, type InstallerRequester } from "./harnessInstallerProbe.js";

type BufferDownloader = {
  downloadToBuffer: (url: URL, options: { cancellationToken: CancellationToken }) => Promise<Buffer>;
};

/** 只缓存本次已核对版本的差分索引；安装包仍由原生更新器下载和校验。 */
export class HarnessPreparedDownload {
  private cached: { url: string; bytes: Buffer } | undefined;
  private readyAt = 0;
  private readonly executor: BufferDownloader;
  constructor(updater: AppUpdater, private readonly probe?: (url: URL, size?: number) => Promise<void>) {
    // electron-updater 的公开运行对象暴露执行器，类型声明未导出；将接缝限制在此处。
    this.executor = Reflect.get(updater, "httpExecutor") as BufferDownloader;
  }
  async prepare(info: UpdateInfo) {
    const file = info.files.find(file => file.url.endsWith(".exe"));
    if (!file) throw new Error("更新没有 Windows 安装包");
    const name = file.url.split("/").at(-1)!;
    const url = new URL(`https://github.com/abbcreat-cyber/stepfun-harness/releases/download/v${encodeURIComponent(info.version)}/${encodeURIComponent(name)}.blockmap`);
    if (this.cached?.url === url.href && Date.now() - this.readyAt < 60000) return;
    const cached = this.cached?.url === url.href ? this.cached.bytes : undefined;
    this.cached = undefined; this.readyAt = 0;
    const cancellationToken = new CancellationToken();
    const timer = setTimeout(() => cancellationToken.cancel(), 60000);
    try {
      const bytes = cached ?? await this.executor.downloadToBuffer(url, { cancellationToken });
      const blockmap = JSON.parse(gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString());
      if (!blockmap.version || !Array.isArray(blockmap.files)) throw new Error("Invalid update index");
      const installer = new URL(url.href.slice(0, -".blockmap".length));
      if (this.probe) await this.probe(installer, file.size);
      else await probeInstallerConnection(this.executor as BufferDownloader & InstallerRequester, installer, file.size);
      this.cached = { url: url.href, bytes };
      this.readyAt = Date.now();
    } finally { clearTimeout(timer); }
  }
  usePrepared() {
    const executor = this.executor, original = executor.downloadToBuffer, cached = this.cached;
    // 只复用 URL 完全一致且已解析的索引；其他请求保持原下载器、认证和取消语义。
    const cachedDownload: BufferDownloader["downloadToBuffer"] = async (url, options) => {
      if (cached?.url === url.href && !options.cancellationToken.cancelled) return Buffer.from(cached.bytes);
      return original.call(executor, url, options);
    };
    executor.downloadToBuffer = cachedDownload;
    return () => { if (executor.downloadToBuffer === cachedDownload) executor.downloadToBuffer = original; };
  }
}
