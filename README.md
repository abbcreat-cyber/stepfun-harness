<div align="center">

# 阶跃星辰 Harness
### 让 AI 走出聊天框，在你的电脑上真正开工。

**StepFun Harness · 社区桌面 AI 工作台**

[English](README.en.md) · [开始使用](docs/GETTING-STARTED.md) · [许可](LICENSES.md) · [反馈](https://github.com/abbcreat-cyber/stepfun-harness/issues)

![Windows installer](https://img.shields.io/badge/Windows-x64_Installer-0078D4?style=flat-square)
![Core license](https://img.shields.io/badge/Core-Apache--2.0-green?style=flat-square)
![Runtime](https://img.shields.io/badge/Runtime-Step_Code-blue?style=flat-square)

**从一句需求，到工具执行、多代理协作，再到可交付文件。**

</div>

阶跃星辰 Harness 将 Step Code 底座接入完整桌面界面，把模型、文件、终端、浏览器、插件与工作流放进同一个工作空间。使用 Step Plan 订阅，或配置 API 和自定义模型；任务过程、并行代理与最终产物，都能在界面中查看。

> **社区项目，非阶跃星辰、Z.ai、DeepSeek 或 OpenAI 官方产品。** 提供 Windows x64 安装包与源码。主工程开源；随附第三方插件保留独立许可，四类原版文档技能含非商业限制，详见 [LICENSES.md](LICENSES.md)。

![桌面工作台与账户余额](docs/screenshots/workspace.png)

## 不止回答，还能把事做完

| 能力 | 用起来是什么样 |
|---|---|
| **订阅 + API 同时接入** | Step Plan、阶跃 API、自定义供应商在同一个模型选择器中使用。 |
| **本机工具与内置浏览器** | 读取文件、执行命令、处理网页，模型推理与本机执行通过适配层连接。 |
| **可视化多代理工作流** | 查看阶段、并行子任务、运行状态和产物，保存流程供后续复用。 |
| **内置文档插件与工具** | Word、PDF、演示文稿、表格等技能和运行库随安装包提供，点选 `@插件` 激活。 |
| **Mini 任务悬浮条** | 主窗口之外查看进行中的任务与数量，按需展开。 |
| **统一更新中心** | 软件更新连接本项目 GitHub Release，Step 底座更新连接官方源，版本和进度分别展示。 |
| **会话统计** | 模型用时、工具用时、首 token 延迟、输出速度、Token 与缓存情况。 |
| **两个内置钩子** | 第一性原理提醒、开场说明默认开启，可独立关闭，下一轮生效。 |
| **交互与持续任务** | 交互式提问、追加消息、取消操作和持久化定时任务。 |

### 一个界面，连接订阅与 API

选择适合当前任务的模型与通道。自定义供应商支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 协议；具体能力仍取决于所选模型和服务商。

![订阅、API 和自定义模型设置](docs/screenshots/connections.png)

### 让协作过程看得见

并行调研，再汇总产物，最后交给独立代理检查。工作流面板展示阶段和真实执行状态，而不只是聊天里的一句“正在处理”。

![多代理工作流与产物面板](docs/screenshots/workflows.png)

### 主窗口之外，也能跟上任务

Mini 悬浮条让你在主窗口之外，随时查看正在进行的任务、任务数量和执行状态，展开即可继续跟进。

<img src="docs/screenshots/mini.png" alt="Mini 任务悬浮条" width="420" />

### 速度与消耗，不用猜

查看每次会话的耗时、响应速度、Token 消耗和缓存用量，了解任务的执行效率。

![会话耗时、输出速度和 Token 统计](docs/screenshots/statistics.png)

## 开始使用

1. 前往 **[下载 Windows 安装包](https://github.com/abbcreat-cyber/stepfun-harness/releases/latest)**，下载 `.exe` 文件。
2. 运行安装程序，选择安装目录。安装后桌面会出现 **“阶跃星辰”** 快捷方式。
3. 双击打开，连接自己的 Step Plan 订阅、API 或自定义模型，即可开始任务。

**无需另装 Node.js、Python、Git Bash 或 Step CLI。** 安装包带齐真实 Step 底座、适配层、文档运行库、轻量 Office 引擎、两个内置钩子和插件。模型账号与额度由用户自行提供。

开发者也可以从源码运行：

```powershell
git clone https://github.com/abbcreat-cyber/stepfun-harness.git
cd stepfun-harness
corepack enable
corepack prepare pnpm@10.33.2 --activate
pnpm install
pnpm harness:doctor
pnpm harness:dev
```

数据目录、源码开发环境及安装包构建方法见 **[开始使用](docs/GETTING-STARTED.md)**。

## 插件与内置钩子

- 内置 Word、PDF、演示文稿、表格、浏览器操作和技能创建等插件，通过 `@插件` 选择任务需要的能力。
- **第一性原理提醒**：明确目标、事实和约束，再推导与验证方案。
- **开场说明**：执行工具前先说明目标和第一步，让任务过程更容易跟进。
- 两个内置钩子默认开启，可在设置中分别开关。

## 架构与贡献

```text
桌面 UI → Host / Services → stepcode-adapter → Step Code RPC
                                  ↓
                   本机工具 · 浏览器 · 插件 · 工作流
```

我们重点维护桌面与底座之间的真实连接：输入、工具、交互、事件、取消、状态和产物。欢迎有复现步骤的问题与小范围、可验证的修复。不要提交 API Key、令牌或私人会话。

[贡献指南](CONTRIBUTING.md) · [构建与发布](docs/BUILDING.md) · [第三方声明](THIRD-PARTY-NOTICES.md)

## 致谢

- **[ZCode](https://github.com/zai-org/ZCode)**：桌面界面、工程基础，以及插件、工作流等能力的来源。
- **[Step Code](https://github.com/stepfun-ai/Step-Code)**：实际 Agent 底座与 RPC，派生适配代码保留其 MIT 声明。
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**：Harness 工作方式与产品功能的参考和启发。
- **[Codex](https://openai.com/codex/)**：任务交互、Mini 入口和过程表达等设计的参考，以及开发过程中的帮助。

谢谢这些项目，让社区能够继续把 AI 工具做得更实用。


