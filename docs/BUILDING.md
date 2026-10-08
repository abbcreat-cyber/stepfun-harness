# Building Windows installers / 构建 Windows 安装包

End users only need the `.exe` installer. This page is for maintainers.
普通用户只需下载并运行安装包，本页供构建者使用。

## 1. Source dependencies

Use Node 24 and pnpm 10.33.2, then run `pnpm install`. Run `pnpm --filter 'stepcode-adapter^...' -r build` to build the adapter's workspace dependencies. Prepare the Electron runtime assets with `pnpm prepare:desktop-runtime` (requires network). These are build inputs, not user configuration.

## 2. Runtime inputs

Prepare clean, unconfigured distributions in a build directory:

| Component | Pinned first-release input |
|---|---|
| Step | 0.1.3, Windows x64, official [manifest](https://static-openapi.stepfun.com/stepcode/latest.json); ZIP SHA-256 `43f6d0f49b762b47ebdbdf182c15ee177f853f26af9e3936745592413d93411e` |
| Node | 24.18.0 Windows x64, [distribution and checksums](https://nodejs.org/dist/v24.18.0/) |
| Python | 3.12.10 Windows x64 embeddable ZIP, [python.org](https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip) |
| Git Bash | PortableGit 2.56.0.2 x64, [official release](https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.2); SHA-256 `075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b` |
| LibreOffice | 25.8.4.2 Windows x64, extracted installation including its license files |
| Python packages | `tools/documents/requirements.lock.txt`; install into a clean target directory with pip or uv |
| Node document packages | `tools/documents/package-lock.json`; copy these two JSON files to a clean folder and run `npm ci` there |

Never copy a venv executable: it usually depends on the build machine's Python installation. The staging script uses official embedded Python and a relative `._pth` file, with no virtualenv activation scripts. Preserve all upstream licenses.

Create a local `runtime-input.json` (do not commit machine paths), substituting your directories:

```json
{
  "node": "D:/build/node/node.exe",
  "nodeDirectory": "D:/build/node",
  "nodeLicense": "D:/build/node/LICENSE",
  "step": "D:/build/step-0.1.3",
  "stepLicense": "D:/build/Step-Code-LICENSE",
  "git": "D:/build/PortableGit",
  "pythonEmbed": "D:/build/python-embed",
  "pythonPackages": "D:/build/python-packages",
  "documentNode": "D:/build/document-node",
  "libreOffice": "D:/build/LibreOffice"
}
```

```powershell
pnpm --filter 'stepcode-adapter^...' -r build
node scripts/stage-harness-runtime.mjs D:/build/runtime-input.json
pnpm harness:prepare
$env:STEP_BACKEND='stepcode-local'
$env:ZCODE_ENV='production'
pnpm --filter @zcode/desktop build:no-runtime-assets
pnpm harness:pack
```

The adapter deployer copies real files and resolves each package's installed dependency version. It does not ship symlinks into a developer checkout. Its dependency inventory and runtime binary hashes are in `resources/harness-runtime`.

## 3. Verification and release

Run `pnpm typecheck`, `pnpm lint`, `pnpm harness:test` and `pnpm architecture:check`. Then verify the built package after relocation with a minimal PATH and isolated `HARNESS_HOME`. Test actual installation, desktop shortcut target/icon, first launch, local-fixture model completion, hooks, plugins, document generation and uninstall. Do not use paid models for release tests.

Bump the root package version before building a desktop release. Publish the installer, `.blockmap`, and generated `latest.yml` together in a **published GitHub Release** in `abbcreat-cyber/stepfun-harness`. The desktop updater validates downloads using the manifest's SHA-512; source-only pushes and drafts are not updates. Step runtime updates remain separate and validate the official SHA-256. Always include SHA-256 checksums for manual downloads and disclose signing status.

The GitHub repository and runtime versions are build-time inputs. Replacing them requires re-running acceptance, not editing the installed package in place.
