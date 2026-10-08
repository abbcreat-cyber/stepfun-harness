# 开始使用 / Getting started

## 中文

### Windows 安装版

1. 打开 [Releases](https://github.com/abbcreat-cyber/stepfun-harness/releases/latest)，下载 Windows x64 的 `.exe` 安装程序。
2. 运行安装程序并选择目录。桌面和开始菜单自动创建 **阶跃星辰** 快捷方式，使用项目星辰图标。
3. 双击快捷方式，在首次引导中连接自己的订阅、API 或自定义模型。

安装包已包含 Step 0.1.3、Node、Git Bash、Python 文档运行库、LibreOffice、插件和两个内置钩子。无需另装开发环境。Android 插件默认关闭，需要额外的 SDK/AVD；第三方在线服务需要用户自己的账号。

本版本没有代码签名证书，Windows 可能显示未知发布者。请从本仓库下载并核对 Release 中的 SHA-256。卸载可通过 Windows“设置 → 应用 → 已安装的应用”进行。

### 用户数据与钩子

安装版默认数据目录：`%APPDATA%/StepFun Harness`。可通过 `HARNESS_HOME` 指定另一个目录。安装文件与用户数据分开；升级不会把 API 配置打进安装包。卸载保留用户数据，彻底删除时请在退出软件后自行备份并移除该目录。

| 位置 | 内容 |
|---|---|
| `state/desktop-hooks.json` | 第一性原理提醒、开场说明的开关，默认均开启 |
| `state/plugins/` | 插件声明与状态 |
| `agent/` | Step 配置 |
| `settings/` | 桌面设置 |
| `conversations/` | 会话 |
| `runtime/` | 应用内更新的 Step 底座 |

“设置 → 钩子 → 已安装”可独立开关两个内置钩子，下一轮生效。界面的“检查更新”检查 Step 底座；桌面新版本在本仓库 Releases 下载。

### 从源码开发

开发者需要 Node.js 24、pnpm 10.33.2、Git for Windows，以及 [Step Code CLI](https://github.com/stepfun-ai/Step-Code#installation)。安装后先运行 `step --version`。

```powershell
git clone https://github.com/abbcreat-cyber/stepfun-harness.git
cd stepfun-harness
corepack enable
corepack prepare pnpm@10.33.2 --activate
pnpm install
pnpm harness:doctor
pnpm harness:dev
```

源码启动默认用户目录为 `~/.stepfun-harness`。`HARNESS_STEP_BIN` 可指定 Step 路径。文档开发工具可运行 `scripts/setup-document-tools.ps1` 安装，再配置 LibreOffice；安装版用户无需这些操作。

### 构建完整安装包

见 [BUILDING.md](BUILDING.md)。构建时先准备真实运行时，再构建桌面和 NSIS 安装包。`harness:pack` 不会下载模型，也不会附带账号。

## English

Download the Windows x64 `.exe` from [Releases](https://github.com/abbcreat-cyber/stepfun-harness/releases/latest), run it, and choose an installation directory. The installer creates the **阶跃星辰** desktop and Start menu shortcut with the star icon. Open it and configure your own subscription or model API.

The package includes Step 0.1.3, Node, Git Bash, a relocatable Python document runtime, LibreOffice, plugins, and both built-in hooks. No development environment is required. Android is disabled by default and requires a separately configured SDK/AVD. Online services require your own accounts.

This build is unsigned. Windows may show an unknown publisher; download from this repository and verify the release SHA-256 checksums. Uninstall through Windows Settings → Apps. User data is kept separately at `%APPDATA%/StepFun Harness` and retained on uninstall. `HARNESS_HOME` can override this location.

The hooks page controls **First-principles reminder** and **Opening explanation**, both enabled by default and effective on the next turn. Check for updates updates the Step runtime; desktop updates are published in GitHub Releases.

Source development requires Node 24, pnpm 10.33.2, Git for Windows and the real Step CLI. Follow the commands above. Source launches default to `~/.stepfun-harness`; `HARNESS_STEP_BIN` selects a CLI and `HARNESS_DOCUMENT_RUNTIME` selects document tools. See [BUILDING.md](BUILDING.md) for a self-contained installer build, and [LICENSES.md](../LICENSES.md) for third-party terms.

