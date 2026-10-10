import { normalizeWorkspaceRelativeFilePath, parseMarkdownFileLinkTarget } from "./markdownFileLink.js";
import { encodeUriPathForFileUrl, joinFilePath } from "./path.js";

interface MarkdownUrlNode {
  type: string;
  url?: string;
  children?: MarkdownUrlNode[];
}

export function resolveMarkdownDocumentHref(workspacePath: string, documentPath: string, href: string): string {
  // 文档资源相对文档目录，聊天资源仍相对项目。只转换相对 URL，保留协议与绝对路径规则。
  if (!href || href.startsWith("\\\\") || /^(?:[/#~]|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(href)) return href;
  const root = workspacePath.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  const source = documentPath.replaceAll("\\", "/");
  const windows = /^[a-zA-Z]:(?:\/|$)/.test(root) || root.startsWith("//");
  const compare = (value: string) => windows ? value.toLowerCase() : value;
  const prefix = root.endsWith("/") ? root : root + "/";
  if (!compare(source).startsWith(compare(prefix))) return "#";
  const parent = source.slice(prefix.length).split("/").slice(0, -1).join("/");
  const parsed = parseMarkdownFileLinkTarget(href);
  const relative = normalizeWorkspaceRelativeFilePath(`${parent}/${parsed.path}`);
  if (relative === null) return "#";
  const absolute = joinFilePath(root, relative);
  // 交给既有 rehype/renderer 的依然是 URL；重新编码避免后续解析把字面 %23 再解码成 #。
  const encoded = encodeUriPathForFileUrl(/^[a-zA-Z]:\//.test(absolute) ? `/${absolute}` : absolute);
  const suffix = parsed.lineNumber === null ? "" : `:${parsed.lineNumber}${parsed.columnNumber === null ? "" : `:${parsed.columnNumber}`}`;
  return encoded + suffix;
}

export function markdownDocumentLinksRemarkPlugin({ workspacePath, documentPath }: {
  workspacePath: string;
  documentPath: string;
}) {
  // Streamdown 按插件函数名和选项缓存 processor；不能把文档路径藏在匿名闭包中。
  return (tree: MarkdownUrlNode) => {
    const visit = (node: MarkdownUrlNode) => {
      if (["link", "image", "definition"].includes(node.type) && typeof node.url === "string") {
        node.url = resolveMarkdownDocumentHref(workspacePath, documentPath, node.url);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
