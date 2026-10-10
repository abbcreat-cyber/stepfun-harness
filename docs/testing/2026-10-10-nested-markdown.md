# 子目录文档、特殊附件与 Unicode 输出验收

基线 `ceaaa16`（v1.0.7）。本机正式包发现问题，隔离候选包修复并复测；使用后台 Inspector/CDP/DOM，真实任务只使用 Step Plan 订阅。

## 确认并修复

- Markdown 文件内的相对图片以项目根目录查找，子目录图片打不开。改为在 Markdown AST 中以源文档目录解析本地相对 URL，再交给现有图片/链接解析器。
- 文档内文件链接缺少打开回调。补齐 PreviewPane → PreviewPaneContent → MarkdownPreviewContent → MessageResponse 的原预览入口，同时保留原 workspace 身份。
- 首个候选暴露了 Streamdown processor 缓存问题：匿名闭包未把路径纳入缓存键。改成具名插件与显式路径选项，并用真实 Streamdown SSR 验证聊天、不同目录相同内容之间不会串用路径。

## 九项桌面验收

| 场景 | 结果 |
| --- | --- |
| 子目录 Markdown 相对图片 | 中文、空格、编码井号文件名正确加载，真实图片尺寸为 237×113 |
| 同目录文档链接 | 打开正确同级文件，没有误开项目根目录的同名诱饵 |
| 上级目录链接 | `../target.md` 正确打开父目录文件 |
| 引用式链接与字面百分号 | definition 路径正确解析，literal%23.md 未被二次解码成 literal#.md |
| 真实模型生成多页文档 | `step-session_8304f027-bdba-49fe-87a5-b62b770211e4`：模型创建入口和详情 Markdown，点击入口里的相对链接成功显示详情 |
| 旧聊天百分号链接 | 复用历史任务，仍打开原百分号文件 |
| 预览刷新阅读位置 | 内容刷新后仍保持 700 像素滚动位置 |
| 特殊文件名附件 | `step-session_50acf3c4-58a7-4089-a93c-12d212843234`：包含中文、空格、#、%、emoji 的文件成功提交，正文编号和 27.60 金额正确 |
| Unicode 标准输出与错误输出 | `step-session_7711197c-28dd-4d45-b224-2b04f072c5b7`：实际 run_command 回执保留两路中文及 emoji，无乱码 |

首轮失败及最后成功结果分别保留在本机 QA 目录 `results-1791620476877.json`、`results-1791621097667.json`；候选开发中的失败保留在 `results-1791620812377.json`。

## 自动检查与交付

路径/编码、AST 转换、真实 Streamdown 缓存回归共 4 项通过；类型检查、production build、架构检查通过，Lint 为原有 77 warnings / 0 errors。源文档内容、底座与 RPC 未修改。已替换本机 app.asar 并后台重启，保留原包备份；仅本地 Git，不推送、不发布。
