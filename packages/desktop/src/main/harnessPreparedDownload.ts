import { CancellationToken, type AppUpdater, type UpdateInfo } from "electron-updater";
import { gunzipSync } from "node:zlib";

type BufferDownloader = {
  downloadToBuffer: (url: URL, options: { cancellationToken: CancellationToken }) => Promise<Buffer>;
};

/** 只缓存本次已核对版本的差分索引；安装包仍由原生更新器下载和校验。 */
export class HarnessPreparedDownload {
  private cached: { url: string; bytes: Buffer } | undefined;
  private readonly executor: BufferDownloader;
  constructor(updater: AppUpdater) {
    // electron-updater 的公开运行对象暴露执行器，类型声明未导出；将接缝限制在此处。
    this.executor = Reflect.get(updater, "httpExecutor") as BufferDownloader;
  }
  async prepare(info: UpdateInfo) {
    const file = info.files.find(file => file.url.endsWith(".exe"));
    if (!file) return;
    const name = file.url.split("/").at(-1)!;
    const url = new URL(`https://github.com/abbcreat-cyber/stepfun-harness/releases/download/v${encodeURIComponent(info.version)}/${encodeURIComponent(name)}.blockmap`);
    if (this.cached?.url === url.href) return;
    this.cached = undefined;
    const cancellationToken = new CancellationToken();
    const timer = setTimeout(() => cancellationToken.cancel(), 60000);
    try {
      const bytes = await this.executor.downloadToBuffer(url, { cancellationToken });
      const blockmap = JSON.parse(gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString());
      if (!blockmap.version || !Array.isArray(blockmap.files)) throw new Error("Invalid update index");
      this.cached = { url: url.href, bytes };
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
