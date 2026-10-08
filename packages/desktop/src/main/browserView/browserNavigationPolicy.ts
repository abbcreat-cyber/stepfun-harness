import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/** 本地 HTML 是正常预览产物；两层白名单曾同时拒绝 file，导致模型只能另起 HTTP 服务。 */
export function isLocalHtmlBrowserUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "file:" || url.hostname) return false;
    const path = fileURLToPath(url);
    // 不把远程共享、设备路径或非法 Windows 文件流当成普通本地页面。
    if (/^(?:\\\\|\/\/)/u.test(path) || path.includes("\0")) return false;
    if (process.platform === "win32" && path.slice(2).includes(":")) return false;
    return [".html", ".htm"].includes(extname(path).toLowerCase());
  } catch {
    return false;
  }
}

/** 仅用户/工具导航接纳本地 HTML；页面自行导航还需校验当前来源。 */
export function isAllowedBrowserUrl(rawUrl: string): boolean {
  if (rawUrl === "about:blank" || isLocalHtmlBrowserUrl(rawUrl)) return true;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isAllowedLocalHtmlTransition(targetUrl: string, currentUrl: string): boolean {
  try {
    if (new URL(targetUrl).protocol !== "file:") return true;
    return isLocalHtmlBrowserUrl(targetUrl) && isLocalHtmlBrowserUrl(currentUrl);
  } catch {
    return false;
  }
}
