# 内置浏览器本地 SVG 预览

本地导航规则仅支持 HTML/HTM，导致浏览器工具打开 SVG 产物时报 navigation_blocked，被迫启动静态服务器。本次将 SVG 纳入同一显式本地预览入口，保留 http/https、HTML 及相对资源能力。

工具/用户发起导航 → 共享本地预览 URL 规则 → Electron guest 导航与渲染 → 原截图接口。主进程工具命令与 webview attach/navigation 使用同一规则。文件路径按 URL 标准解析，中文原文/百分号编码/大小写扩展名/查询和片段一致；不猜改文件名。合法类型的不存在路径返回真实加载错误，不伪装成 URL 拦截。

页面从 HTTP/HTTPS 自行跳转或弹出本地文件仍被阻止；本地预览之间可跳转。UNC、设备路径、Windows 文件流、NUL、javascript/data URL 和其他文件类型继续拒绝。sandbox、contextIsolation、webSecurity 均保持启用，不增加 Node 或宿主桥访问。

验证：复现原 SVG 拦截；修后直接打开实际 SVG 与中文编码路径并截图；缺失 SVG 如实失败；HTML、HTTP 与来源边界回归。用 Step Plan 小任务实际调用浏览器。只提交和部署本地修复，不发布；打包使用隔离源码以保留其他并行改动。
