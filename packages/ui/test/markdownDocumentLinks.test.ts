import test from "node:test";
import assert from "node:assert/strict";
import { markdownDocumentLinksRemarkPlugin, resolveMarkdownDocumentHref } from "../src/lib/markdownDocumentLinks.js";
import { resolveMarkdownFileLink } from "../src/lib/markdownFileLink.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";

test("文档相对 URL 保留原 workspace，支持同级、父级和编码文件名", () => {
  const root = "D:/project", doc = "D:/project/docs/sub/readme.md";
  const resolve = (href: string) => resolveMarkdownFileLink(root, resolveMarkdownDocumentHref(root, doc, href))?.path;
  assert.equal(resolve("sibling.md"), "D:/project/docs/sub/sibling.md");
  assert.equal(resolve("../other.md"), "D:/project/docs/other.md");
  assert.equal(resolve("./images/图%20%23.png"), "D:/project/docs/sub/images/图 #.png");
  assert.equal(resolve("literal%2523.md"), "D:/project/docs/sub/literal%23.md");
  assert.equal(resolveMarkdownDocumentHref(root, doc, "../../../outside.md"), "#");
  assert.equal(resolveMarkdownDocumentHref(root, "D:/project-other/file.md", "x.md"), "#");
  assert.equal(resolveMarkdownDocumentHref("/repo", "/repo/sub/file.md", "../x.md"), "/repo/x.md");
  assert.equal(resolveMarkdownDocumentHref("/", "/docs/file.md", "x.md"), "/docs/x.md");
  assert.equal(resolveMarkdownDocumentHref("D:/", "d:/docs/file.md", "../x.md"), "/D:/x.md");
  assert.equal(resolveMarkdownDocumentHref("D:/PROJECT", "d:/project/sub/file.md", "x.md"), "/D:/PROJECT/sub/x.md");
  assert.equal(resolveMarkdownDocumentHref(root, doc, "https://example.com/a?q=1"), "https://example.com/a?q=1");
  assert.equal(resolveMarkdownDocumentHref(root, doc, "#section"), "#section");
  assert.equal(resolveMarkdownDocumentHref(root, doc, "\\\\server\\share\\image.png"), "\\\\server\\share\\image.png");
  assert.equal(resolveMarkdownFileLink(root, "./sibling.md")?.path, "D:/project/sibling.md");
});

test("AST 只转换链接、图片和引用定义，不触碰正文或代码", () => {
  const nodes = ["link", "image", "definition", "code", "text"].map(type => ({ type, url: "target.md" }));
  markdownDocumentLinksRemarkPlugin({ workspacePath: "/repo", documentPath: "/repo/docs/readme.md" })({ type: "root", children: nodes });
  assert.deepEqual(nodes.map(n => n.url), ["/repo/docs/target.md", "/repo/docs/target.md", "/repo/docs/target.md", "target.md", "target.md"]);
});

test("真实 Streamdown processor 不在不同文档目录和聊天间复用解析基准", () => {
  const render = (documentPath?: string) => renderToStaticMarkup(createElement(Streamdown, {
    mode: "static", rehypePlugins: [],
    components: { a: ({ href }: { href?: string }) => createElement("a", { href }, "next") },
    remarkPlugins: documentPath ? [[markdownDocumentLinksRemarkPlugin, { workspacePath: "/repo", documentPath }]] : [],
    children: "[next](target.md)",
  }));
  assert.match(render(), /href="target.md"/);
  assert.match(render("/repo/a/index.md"), /href="\/repo\/a\/target.md"/);
  assert.match(render("/repo/b/index.md"), /href="\/repo\/b\/target.md"/);
  assert.match(render("/repo/a/index.md"), /href="\/repo\/a\/target.md"/);
  assert.match(render(), /href="target.md"/);
});
