import type { IncomingMessage, RequestOptions } from "node:http";
import type { ClientRequest } from "electron";

export type InstallerRequester = {
  createRequest: (options: RequestOptions & { redirect: "follow" }, callback: (response: IncomingMessage) => void) => ClientRequest;
};

/** 使用原更新器的代理/session，只确认首块可读；Range 被忽略时也不下载整包。 */
export function probeInstallerConnection(executor: InstallerRequester, url: URL, expectedSize?: number, timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined, done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer); request?.abort();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("更新下载连接未就绪，请稍后重试")), timeoutMs);
    try {
      request = executor.createRequest({ protocol: url.protocol, hostname: url.hostname, port: url.port,
        path: url.pathname + url.search, method: "GET", redirect: "follow", headers: { Range: "bytes=0-1023" } }, response => {
        if (response.statusCode !== 200 && response.statusCode !== 206) { finish(new Error(`更新下载连接失败 (${response.statusCode})`)); return; }
        const range = String(response.headers["content-range"] ?? "");
        const match = /^bytes 0-\d+\/(\d+)$/.exec(range);
        const total = response.statusCode === 206 ? Number(match?.[1]) : Number(response.headers["content-length"]);
        if (response.statusCode === 206 && !match || expectedSize && total && total !== expectedSize) { finish(new Error("更新安装包大小不匹配")); return; }
        let prefix = Buffer.alloc(0);
        response.on("data", (chunk: Buffer) => {
          if (done) return;
          prefix = Buffer.concat([prefix, chunk.subarray(0, 2 - prefix.length)]);
          if (prefix.length >= 2) finish(prefix[0] === 0x4d && prefix[1] === 0x5a ? undefined : new Error("更新地址未返回有效安装包"));
        });
        response.on("error", finish);
        response.on("end", () => { if (!done) finish(new Error("更新安装包没有可读内容")); });
      });
      request.on("error", finish);
      request.end();
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
