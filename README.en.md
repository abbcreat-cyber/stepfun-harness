<div align="center">

# StepFun Harness
### Bring AI beyond chat—and into action on your desktop.

**A community-built desktop AI workspace**

[简体中文](README.md) · [Get started](docs/GETTING-STARTED.md#english) · [Licenses](LICENSES.md) · [Issues](https://github.com/abbcreat-cyber/stepfun-harness/issues)

![Windows installer](https://img.shields.io/badge/Windows-x64_Installer-0078D4?style=flat-square)
![Core license](https://img.shields.io/badge/Core-Apache--2.0-green?style=flat-square)
![Runtime](https://img.shields.io/badge/Runtime-Step_Code-blue?style=flat-square)

**From a request to tool execution, coordinated agents, and deliverable files.**

</div>

StepFun Harness connects the Step Code agent runtime to a full desktop interface. Models, local files, terminal tools, an embedded browser, plugins, and workflows share one workspace. Use Step Plan alongside API connections and custom providers, and follow tasks through their progress, parallel agents, and final artifacts.

> **An independent community project, not an official StepFun, Z.ai, DeepSeek, or OpenAI product.** Windows x64 installer and source code are provided. Core code is open source; bundled plugins retain separate licenses. Four original document skills have non-commercial restrictions. See [LICENSES.md](LICENSES.md).

![Desktop workspace and account balance](docs/screenshots/workspace.png)

## More than a chat window

| Capability | What it gives you |
|---|---|
| **Subscriptions and APIs together** | Step Plan, StepFun API, and custom providers in one model picker. |
| **Local tools and an embedded browser** | Work with files, run commands, and interact with web pages through the adapter. |
| **Visible multi-agent workflows** | Inspect phases, parallel tasks, status, and artifacts; save workflows for reuse. |
| **Bundled document plugins** | Word, PDF, presentations, and spreadsheet skills with supporting assets; activate with `@plugin`. |
| **Mini task strip** | Follow active tasks and counts outside the main window. |
| **Session statistics** | Model/tool time, first-token latency, output speed, tokens, and cache usage. |
| **Two built-in hooks** | First-principles reminder and opening explanation, enabled by default and independently configurable. |
| **Interactive and continuing work** | Structured questions, follow-up messages, cancellation, and persistent scheduled tasks. |

### Connect the model you need

Choose a subscription or API connection without switching apps. Custom providers support OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. Capabilities still depend on the model and service.

![Subscription, API, and provider settings](docs/screenshots/connections.png)

### See collaboration happen

Research in parallel, consolidate an artifact, and ask another agent to review it. The panel exposes execution state, phases, and deliverables.

![Multi-agent workflow and artifacts](docs/screenshots/workflows.png)

### Keep tasks within reach

The Mini strip is a lightweight task entry point outside the main window. Mini voice features are not included.

<img src="docs/screenshots/mini.png" alt="Mini task strip" width="420" />

### Understand time and usage

Inspect response speed and consumption. Screenshot numbers are from one demonstration, **not a benchmark or performance guarantee**.

![Session timing and token statistics](docs/screenshots/statistics.png)

## Get started

1. **[Download the Windows installer](https://github.com/abbcreat-cyber/stepfun-harness/releases/latest)** (`.exe`).
2. Run the installer and choose a destination. It creates the **阶跃星辰** desktop shortcut with the project's star icon.
3. Open the shortcut and connect your own subscription, API key, or custom model.

**No separate Node.js, Python, Git Bash, or Step CLI setup is required.** The installer includes the real Step runtime, adapter, document libraries, LibreOffice, both built-in hooks, and plugins. Bring your own model account and credits.

For source development:

```powershell
git clone https://github.com/abbcreat-cyber/stepfun-harness.git
cd stepfun-harness
corepack enable
corepack prepare pnpm@10.33.2 --activate
pnpm install
pnpm harness:doctor
pnpm harness:dev
```

See **[Get started](docs/GETTING-STARTED.md#english)** for data locations, source development and installer builds.

## Plugins and hooks

- **Eight third-party packages** are included: documents, PDF, presentations, spreadsheets, browser-use, Node Repl Host, skill-creator, and Android emulator. Android is off by default and requires an SDK/AVD. Node Repl Host is an execution dependency.
- The adapter connects the browser and workflows; native Step capabilities remain owned by Step. A plugin directory does not prove external services or tools are ready.
- **First-principles reminder:** identify goals, facts, and constraints before deriving and verifying a solution.
- **Opening explanation:** require visible prose before tools run. Missing prose defers tools once; another silent attempt stops the turn. Explicit output-only requests can be exempt.
- UI and execution share hook configuration. Plugin status distinguishes declarations from loaded skills.

## Current scope

- Windows is the validated target. Inherited macOS/Linux code has not completed this project's release acceptance.
- Bring your own account, subscription, or API key. No credentials or credits are included.
- Images, tools, and reasoning vary by model. Protocol compatibility does not guarantee identical capabilities.
- Screenshots show the maintainer's configured environment. Some UI labels still say `Step Code`.
- Local tools run with the corresponding user's permissions. Begin with a test project and review permissions and cancellation.

## Architecture and contributions

```text
Desktop UI → Host / Services → stepcode-adapter → Step Code RPC
                                    ↓
                       Local tools · Browser · Plugins · Workflows
```

Our focus is connecting UI and execution faithfully: inputs, tools, interactions, events, cancellation, state, and artifacts. Reproducible reports and focused patches are welcome. Never include credentials or private conversations in issues.

[Contributing](CONTRIBUTING.md) · [Release boundary](docs/PUBLISHING.md) · [Third-party notices](THIRD-PARTY-NOTICES.md)

## Acknowledgments

- **[ZCode](https://github.com/zai-org/ZCode)** — the desktop interface, engineering foundation, and upstream plugin/workflow capabilities.
- **[Step Code](https://github.com/stepfun-ai/Step-Code)** — the actual agent runtime and RPC. Derived adapter files preserve its MIT notices.
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — inspiration for harness workflows and product capabilities.
- **[Codex](https://openai.com/codex/)** — references for task interactions, Mini, and progress communication, plus development assistance. Similar UX does not imply copying proprietary implementations or official endorsement.

Thank you for helping the community build more useful AI tools.

