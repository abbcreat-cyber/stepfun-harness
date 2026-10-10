# 文件刷新、混合附件与自由问答批量验收

基线 `f4ac92d`。在独立 QA profile 中使用本机桌面候选包，通过后台 Inspector、CDP、DOM 事件和文件操作验收；真实任务只使用 Step Plan 订阅。没有操作宿主鼠标、使用虚拟机或调用其他模型账户。

## 发现与修复

1. 打开 Markdown 后从外部改写、AI 下一轮修改同一文件，磁盘已经更新而预览仍显示旧内容。原因是文本预览只在打开时读取，原目录监听仅供 PPTX 使用。
2. 将现有监听推广到静态文件预览，保留路径与 workspace service 隔离、取消和迟到结果保护。不监听音视频播放或历史 diff。
3. 开发中的首个候选自动刷新会清空预览，让阅读位置从 700 像素回到顶部。真实桌面复现后拆开文件切换初始化与内容读取，最终候选保持原位置。

## 实测结果

以下 12 项在一轮批量执行中全部通过，原始结果 `results-1791617824214.json` 保存在本机 QA 目录。

| 场景 | 验收证据 |
| --- | --- |
| Markdown 刷新保留阅读位置 | 150 段文档，滚动 700 像素后外部追加文字，显示新文字且 scrollTop 仍为 700 |
| Word 外部替换 | 打开后写入第二版，真实渲染正文显示 SECOND 标记 |
| PDF 外部替换 | 打开后写入第二版，真实 PDF 文本层显示 SECOND 标记 |
| PPTX 外部替换 | 打开后写入第二版，真实幻灯片显示 SECOND 标记 |
| 删除后重建 | 删除显示文件不存在；同路径重建后自动显示新内容 |
| 图片外部替换 | 80×64 图片换为 144×64，预览 naturalWidth/naturalHeight 反映新图片 |
| Markdown 外部修改 | `step-session_d7c9f8ea-65d6-4101-be8c-93be3f16c3da`：回复中的链接打开后，外部写入自动更新 |
| JSON 代码刷新 | 打开后外部写入，代码预览 Shadow DOM 显示新版内容 |
| 混合附件映射 | `step-session_c8445888-b3d0-430a-93ab-a184dbd112b8`：TXT、JSON、CSV 按提交顺序返回正确文件名和不同校验码 |
| 自由输入与返回修改 | `step-session_0cf715b9-d655-4f46-8f90-23702a59b685`：返回第一题修改标题，第二题多行中文和符号不丢失，最终回复符合提交内容 |
| AI 再次编辑 | `step-session_db806fc1-74cd-45c6-8e48-424659b03953`：连续两轮 write_file，文件与已打开预览都显示第二版 |
| 表格公式预览 | 公式 `=SUM(D2:D3)`、缓存数值及真实 canvas 绘制均为 31.5 |

代码预览首轮驱动只读 body.innerText，未穿透 Shadow DOM；修正为穿透定位后重新验证，确认旧版本不刷新、候选刷新。驱动问题不计为产品故障。

最终补测第 13 项：聊天回复的 PPTX 文件链接（`step-session_048e37ef-926f-4cfe-ae5c-d0ecefff6afa`）打开后，外部替换立即显示新版幻灯片。显式 image/pdf/pptx 类型与普通 file 类型共用监听。最终包再次通过阅读位置和删除重建回归。

## 本机交付

正式安装的 app.asar 与最终测试候选 SHA-256 一致：`275cd5083e29d74f6765d683d1e58dae646bd32a34dbbb848724675f8b08048a`。替换前正常退出，保留备份；后台重启后主窗口无运行任务、Mini 数量为 0，两者保持原有隐藏状态。底座二进制未修改。

## 自动回归与边界

- `node --test packages/ui/test/previewFileWatchLifecycle.test.mjs`：真实 React effect + 无头 Chrome，覆盖无关文件事件、Windows 路径归一、未知文件名事件、同路径换 service、旧事件忽略、迟到注册释放、监听失败与卸载清理。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、production desktop build 通过。Lint 为已有 77 warnings / 0 errors。
- 测试文件均在隔离 QA 项目内。未测试手机远程连接，未改变 RPC 或底座。
- 仅本地交付，不推送或发布。
