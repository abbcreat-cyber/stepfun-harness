import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/** HTML 与 SVG 都是可预览产物；工具导航与 webview 必须共享同一类型规则。 */
export function isLocalPreviewBrowserUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "file:" || url.hostname) return false;
    const path = fileURLToPath(url);
    // 不把远程共享、设备路径或非法 Windows 文件流当成普通本地页面。
    if (/^(?:\\\\|\/\/)/u.test(path) || path.includes("\0")) return false;
    if (process.platform === "win32" && path.slice(2).includes(":")) return false;
    return [".html", ".htm", ".svg"].includes(extname(path).toLowerCase());
  } catch {
    return false;
  }
}

/** 仅用户/工具导航接纳本地预览；页面自行导航还需校验当前来源。 */
export function isAllowedBrowserUrl(rawUrl: string): boolean {
  if (rawUrl === "about:blank" || isLocalPreviewBrowserUrl(rawUrl)) return true;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isAllowedLocalPreviewTransition(targetUrl: string, currentUrl: string): boolean {
  try {
    if (new URL(targetUrl).protocol !== "file:") return true;
    return isLocalPreviewBrowserUrl(targetUrl) && isLocalPreviewBrowserUrl(currentUrl);
  } catch {
    return false;
  }
}
