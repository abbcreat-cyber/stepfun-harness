# stepcode-adapter

ZCode 桌面壳（stepcode-desktop）与 Step-Code 之间的**进程级适配层**（社区维护，中性命名
"Step-Code (community)"，不冒充官方）：

- `StepCodeRpcClient` —— 驱动 `step --mode rpc` 子进程（stdin/stdout 严格 JSONL）的零依赖客户端；
- `bin/zcode-bridge.mjs` —— ZCode Protocol 门面进程（stdin/stdout NDJSON，桌面壳 agent 槽位的直接替换物）；
- `mock/step-rpc-mock.mjs` —— 忠实复刻 rpc 协议的 stdio mock 服务器，供无凭据、无真实模型的端到端测试。

Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.

- 纯 ESM JavaScript（`.mjs` + JSDoc 类型注释），零外部依赖，只用 Node 内置模块。
- `node --test` 直接跑测试（Node ≥ 18.11；本仓库用 Node 24 验证）。
- 通信只走子进程 stdio，无任何 HTTP 代码，不需要任何真实凭据。

## 目录

```
packages/stepcode-adapter/
├── bin/
│   └── zcode-bridge.mjs   ZCode Protocol 门面（桌面壳 agent 槽位替换物）
├── src/
│   ├── jsonl.mjs          严格 JSONL 编解码（复刻 Step-Code rpc/jsonl.ts）
│   ├── rpc-protocol.mjs   Step rpc 协议类型（JSDoc）+ 判定函数 + 响应构造器
│   ├── rpc-client.mjs     StepCodeRpcClient（核心）
│   └── wire-shapes.mjs    ZCode Protocol 响应/帧构造工厂（形状对齐 @zcode/shared zod schema）
├── mock/
│   └── step-rpc-mock.mjs  忠实 stdio mock 服务器（bin: step-rpc-mock）
├── tools/
│   ├── schema-probe.mjs   用仓库 zod schema 自校验 wire 形状（tsx 跑）
│   └── bridge-smoke.mjs   门面端到端冒烟（模拟 host 调用序列）
├── suites/                真实测试套件（*.mjs，不带 .test. 后缀、不在 test/ 内——见下）
└── test/
    └── index.js           聚合入口：import 全部套件
```

## 测试

```sh
# 以下任一形式都会跑全部 45 个测试（Node 24 实测通过；jsonl 7 + rpc-approval 7
# + rpc-command-roundtrip 14 + rpc-lifecycle 10 + rpc-streaming 4 + zcode-bridge 3）：
node --test test                                    # 包目录下，目录形式
node --test stepcode-desktop/packages/stepcode-adapter/test   # 工作区根，目录形式（正/反斜杠均可）
npm test                                            # 包目录下（= node --test 默认扫描）
```

为什么套件放在 `suites/` 而不是 `test/`：Node 24 的 test runner 把 `--test` 的位置参数按
glob/文件解析，裸目录需要目录内有 `index.js` 才能被模块解析命中（否则报
`Cannot find module ...\<dir>`）；而 `node --test`（无参数）的默认扫描会执行 `test/` 目录下的
**所有**文件（递归）加全仓库 `*.test.*`。把真实套件放在 test/ 之外、目录里只留一个聚合
`index.js`，两种调用方式都恰好各跑一遍、不重复。

覆盖 mockPlan A1-A5：握手（无握手即命令）、一轮问答、流式增量（含 5000 字符压测）、
工具批准往返（allow/deny/cancel/抛错/无 handler/手动/超时）、异常退出（EOF/SIGINT/崩溃/
parse 错误/spawn 失败/kill 兜底）。

## StepCodeRpcClient API

```js
import { StepCodeRpcClient } from "stepcode-adapter"; // 或相对路径 src/rpc-client.mjs

const client = new StepCodeRpcClient({
  // 三种 spawn 方式（优先级从高到低）：
  command: [process.execPath, "/path/to/step.js", "--mode", "rpc"], // 显式 argv
  // 或 nodeExecutable + cliPath + args（默认 node + dist/bundle/step.js --mode rpc）
  cwd: workspaceDir,           // 决定 agent 会话绑定的 workspace
  env: { STEP_API_KEY: "..." },// 或 STEPCODE_CONFIG_PATH 等（见 Step-Code 登录模型）
  requestTimeoutMs: 30000,     // 单请求默认超时
  onUiRequest: async (req) => ({ confirmed: true }), // 工具批准策略（见下）
  manualUiResponses: false,    // true = 不自动回 UI 响应，完全手动 respondUiRequest
});

await client.start();          // spawn + 就绪（rpc 模式无握手帧，进程存活即就绪）

// —— 命令面（壳侧 session/* 的映射目标）——
await client.newSession();                       // session/create → new_session (+setModel)
await client.setModel("step", "step-5-preview"); // session/create → set_model
await client.prompt("hi");                       // session/send → prompt（preflight 成功即返回）
await client.steer("换个方向");                   // session/send → steer（打断改道）
await client.abort();                            // session/stop → abort
await client.getEntries(); / getTree(); / getMessages(); // session/read → get_entries/get_tree
await client.getState(); / getAvailableModels(); / bash("echo hi"); / ...

// —— 流式增量（v4 conversation 帧的内容源）——
const off = client.onEvent((event) => { /* JsonAgentSessionEvent */ });
await client.waitForIdle();                      // agent_settled = 一轮结束的权威信号
const events = await client.promptAndWait("hi"); // prompt + 收集事件直到 settled

// —— 工具批准往返（interaction/requestPermission 的桥接点）——
client.handleUiRequests(async (req) => {
  // req: {type:"extension_ui_request", id, method:"confirm", title, message, timeout?}
  return { confirmed: true };   // 或 {confirmed:false} / {cancelled:true} / {value:"..."}
});                              // 抛错/返回 null → 自动按 {cancelled:true} 回（fail-closed）

// —— 退出与错误传播 ——
const { code, signal } = await client.stop();     // stdin EOF → 等 exit 0；超时 SIGTERM → SIGKILL
client.waitForExit(5000);        // {code, signal}
client.getStderr();              // 子进程 stderr 累计（排障）
client.isRunning();
// 进程崩溃/被杀：所有挂起请求立即 reject（错误含退出码），后续 request 抛 exitError。
```

### 设计要点

- **无握手**：rpc 模式 spawn 后第一条即可发业务命令（rpc-mode.ts:805-813）。`start()` 只等
  spawn 成功，不发探针、零副作用。
- **id 关联**：每个命令自动带 `req_N`（可自带 id），响应按 id 配对分发；无 id 的响应行
  （如 `command:"parse"` 的解析错误）走事件流广播——与官方 RpcClient 一致。
- **批准往返 fail-closed**：未注册 `onUiRequest` 时对 confirm/select/input/editor 自动回
  `{cancelled:true}`（对齐 Step-Code 无 UI 时权限默认拒绝）；`manualUiResponses:true` 可关掉
  自动回应用 `onEvent` + `respondUiRequest(id, resolution)` 完全手动驱动。重复响应同一 id 被忽略。
- **优雅退出**：`stop()` 先 `stdin.end()`（EOF → agent flush 后 exit 0），5s 超时退化 SIGTERM、
  再 1s SIGKILL——适配层负责杀干净自己 spawn 的子进程（防 Windows 上残留进程锁 workspace）。
- **流式增量**：`message_update.assistantMessageEvent` 的 text_delta/toolcall_delta 即 token 级增量；
  `agent_settled` 是一轮结束信号。

## mock 服务器

```sh
node mock/step-rpc-mock.mjs [--hang <commandType>] [--ignore-eof] [--delay <ms>]
```

忠实复刻 rpc-mode 的 wire 行为：无握手、prompt 响应在 preflight 后异步发出、事件流形状对齐
json-event.ts 投影、extension_ui_request/extension_ui_response 往返、stdin EOF → exit 0、
SIGINT/SIGTERM → 130/143、非法 JSON 行 → `command:"parse"` 错误响应。

剧本路由（prompt message）：

| message | 剧本 |
| --- | --- |
| 其它（含 `hi`） | 文本问答：agent_start → user/assistant 消息对 → text_start/delta×N/end → agent_settled |
| `mock:tool` | 工具调用流：toolcall_start（带 id/toolName）→ delta → end + tool_execution_start/update/end |
| `mock:confirm` | 工具批准往返：发 confirm 请求等响应；等待期间持续发 bash_execution_update |
| `mock:confirm-timeout` | 同上但请求带 timeout:250，超时按拒绝（默认 false）继续 |
| `mock:error` | prompt preflight 失败（success:false 错误响应） |
| `mock:crash` | 模拟崩溃：直接 exit(1)，不发 prompt 响应 |
| `mock:exit130` | 回 prompt success 后 exit(130)，模拟 SIGINT |

调试参数：`--hang get_state`（收到该命令不回响应，测超时/pending reject）、`--ignore-eof`
（EOF 不退出，测 kill 兜底）、`--delay 0`（全速，压测分帧）。

## 测试

```sh
cd packages/stepcode-adapter
node --test test   # 或 npm test / node --test（三种形式等价，见下节）
```

覆盖 mockPlan A1-A5：握手（无握手即命令）、一轮问答、流式增量（含 5000 字符压测）、
工具批准往返（allow/deny/cancel/抛错/无 handler/手动/超时）、异常退出（EOF/SIGINT/崩溃/
parse 错误/spawn 失败/kill 兜底）；另有 zcode-bridge 套件（1 个套件 3 个测试：host 完整调用
序列 + sessions-index/workspace-config 初始帧 + 未建会话防护）。`suites/helpers.mjs` 是公共
辅助（无断言，位于 suites/ 目录；test/ 目录只有聚合入口 index.js）。

## 壳侧接线（已集成：STEP_BACKEND 开关）

桌面壳（packages/desktop）已内置可选开关，见 `packages/desktop/src/main/stepcodeBackend.ts`：

```
# 开发态启动前设置（或写进 stepcode-desktop 仓库根 .env / .env.local）
STEP_BACKEND=stepcode-local
```

开关打开时，main 进程在 `buildHostProcessEnv` 里注入
`ZCODE_AGENT_SERVER_COMMAND=node` + `ZCODE_AGENT_SERVER_ARGS_JSON=["<本包>/bin/zcode-bridge.mjs"]`，
走仓库现成的 agent 命令覆盖机制（zcodeAgentProcessManager.resolveDefaultZCodeAgentCommand 的最高
优先分支）——**不改任何 Z.ai 官方链路代码**。默认（不设或设为其他值）行为零变化。

可用 env 微调：`STEPCODE_BRIDGE_ENTRY`（门面路径覆盖）、`STEPCODE_NODE`（node 可执行，默认 PATH 里的
node）、`STEPCODE_BRIDGE_ARGS_JSON`（追加参数数组）。显式设置 `ZCODE_AGENT_SERVER_COMMAND` 时开关
自动让步（显式覆盖优先）；门面文件不存在或打包态（安装包未内置社区后端）时回落官方链路并打警告。

### 门面进程（bin/zcode-bridge.mjs）

ZCode Protocol（NDJSON over stdio）→ StepCodeRpcClient 的最小门面：

- 已实现 host→agent 方法面：`provider/updateAccountConfig`、`session/create`（→ newSession+setModel）、
  `session/subscribe`、`session/send`（→ prompt/steer）、`session/stop`（→ abort）、
  `session/setModel|setThoughtLevel|setMode`、`session/list|messages|events`、`mcp/list`、
  `v4/connection/flow`、`v4/conversation/subscribe|unsubscribe|resync`（含 sessions-index /
  workspace-config topic 的初始帧）、`v4/command`（createSession / sendText / stop）。
- 事件投影：Step 事件流 → legacy `session/event`（turn.started / part.delta / turn.completed）；
  v4 conversation 帧采用 **turn 终态 snapshot 重放**（不做 deltas 增量）——UI 表现为回复在一轮
  结束后一次性出现（已知局限，见下）。
- 未知方法回 JSON-RPC `-32601`（host 按可选能力降级）；stdin EOF → 先优雅停掉 Step 子进程
  （EOF→SIGTERM→SIGKILL）再退出，不留孤儿进程。
- UI 批准策略：**默认 fail-closed 拒绝**（未注册 handler 时 client 对 confirm/select/input/editor
  自动回 `{cancelled:true}`，对齐 Step-Code 无 UI 时的默认拒绝与 rpc-client 自身默认）；
  `--auto-approve 1` 显式切换为自动放行——只建议驱动本包 mock（无真实副作用）时使用，接真实
  Step CLI 请保持默认；反向 `interaction/requestPermission` 桥接待做。
- 默认驱动本包 mock（无凭据冒烟）；接真实 CLI：
  `--step-cli '["node","/path/to/step.js","--mode","rpc"]'`。
- 桌面壳自动追加的 `--surface desktop` 参数被容忍（忽略未知参数）。

```sh
# 手工冒烟（模拟 host 完整调用序列）
npm run bridge:smoke
# 用仓库 zod schema 自校验 wire 形状（在 stepcode-desktop 仓库根跑）
npx tsx packages/stepcode-adapter/tools/schema-probe.mjs --validate
# 桌面壳侧 STEP_BACKEND 开关五场景行为验证（tsx + electron stub，仓库根跑）
npx tsx packages/stepcode-adapter/tools/stepcode-switch-check.mts
```

## 边界（本包不做）

- **v4 deltas 增量帧未实现**：conversation 帧只发 snapshot（订阅初始 + turn 终态重放），
  token 级流式增量（row.delta）与历史会话冷恢复（cold resume 的 rows 重放）留作后续。
- **sdk-stdio 模式（4B 长度前缀帧协议）未实现**：mockPlan 模式 B（initialize 握手、
  query.start/query.message、permission.request 反向请求）留作后续；本包选择 rpc JSONL 模式
  （mockPlan 模式 A，桌面壳首选）。
- **真实 step CLI 未接**：按约束不碰用户私有账号，未用真实凭据做过冒烟；mock 形状全部来自
  Step-Code 源码精读与仓库测试（rpc.test.ts、rpc-prompt-response-semantics.test.ts、
  rpc-client-process-exit.test.ts、rpc-jsonl.test.ts、step-stdio-host.test.ts）的序列。
  后续拿真 CLI 冒烟（STEP_API_KEY 指向本地网关 + --mode rpc）即可校准。
- **Z.ai 账号 mock 网关未实现**：登录侧（ZCODE_BASE_URL/ZAI_OAUTH_ORIGIN 指本地 mock）不在本包范围。
- **interaction/requestPermission 反向请求桥接未实现**：Step 的 extension_ui_request 目前按
  批准策略处理（默认 fail-closed 拒绝；`--auto-approve 1` 时自动放行），未映射到桌面权限弹窗。
