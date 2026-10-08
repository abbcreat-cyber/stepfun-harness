# Step-Code 协议开发者笔记

这份文档服务于 `packages/stepcode-adapter/`（ZCode 桌面壳 ↔ Step-Code 的适配层）的维护者：把 Step-Code CLI 的两种程序化接入协议、审批流、认证模型整理成可查的手册，每条结论都给出源码出处。后来者改 `bin/zcode-bridge.mjs` 或升级 Step-Code 版本时，从这里入手。

**出处约定**：所有 `Step-Code/...` 路径均指本工作区内 `Step-Code` 仓库（上游 <https://github.com/stepfun-ai/Step-Code>，MIT）。行号基于 2026-10 的本地快照，上游演进后请按方法名/字符串全文搜索定位；本次整理时抽查过 `rpc-mode.ts:805-813`、`rpc-mode.ts:1-12`、`stdio-host.ts:392-415` 三处均与快照一致。文中"实测"指在本机（Windows 11、Node v24.18.0）实际运行过；未实测的部分均已注明（真实 CLI 从未运行——无凭据，不碰私有账号）。

---

## 1. 两种接入模式总览

Step-Code CLI（`step` 命令）有两种程序化（headless）接入方式，二选一：

| | A. rpc 模式 | B. sdk-stdio 模式 |
| --- | --- | --- |
| 传输 | stdin/stdout 严格 JSONL（LF 分行） | 4 字节大端长度前缀 + UTF-8 JSON 帧 |
| 握手 | **无**，进程起来即可发命令 | **强制** initialize 握手，未握手发其它方法即协议违规 |
| 信封 | `{type, id?, ...}` 扁平形状 | `{kind, method?, replyTo?, sequence?, payload?, error?}` 信封 |
| 反向请求 | `extension_ui_request` / `extension_ui_response`（同一条 JSONL 流） | `kind:"request"` 帧（permission.request、hook.invoke 等），回复 `kind:"response"` + `replyTo` |
| 多会话 | 单会话进程常驻，命令切换/fork | 单 query 限制（maxConcurrentQueries:1），session.* 管多会话 |
| 启动参数 | `--mode rpc` | `--sdk-stdio`（只能从 step 入口启动） |
| 本适配层 | ✅ 已实现（`src/rpc-client.mjs` + `bin/zcode-bridge.mjs`） | ❌ 未实现（见 §8 边界） |

**选 rpc 的理由**：无握手、形状简单、官方 RpcClient 自身就用它嵌入宿主（`Step-Code/packages/coding-agent/src/modes/rpc/rpc-client.ts:81-94`），且扩展 UI 往返（工具批准）足以覆盖桌面壳当前需求。

---

## 2. 模式 A：rpc（JSONL）

协议头注释权威出处：`Step-Code/packages/coding-agent/src/modes/rpc/rpc-mode.ts:1-12`。

### 2.1 握手与线路格式

- **无握手**：spawn 后进程即监听 stdin，第一条就可以是业务命令（`rpc-mode.ts:805-813`，实测与 `rpc-client.ts` 行为一致）。
- 每行一个 JSON 对象，写侧 `JSON.stringify + "\n"`（`Step-Code/packages/coding-agent/src/modes/rpc/jsonl.ts:10-12`）；读侧严格按 `\n` 切分、容忍行尾 `\r`，**故意不用 readline**（它会按 U+2028/U+2029 分行，`jsonl.ts:21-41`）。适配层的复刻：`packages/stepcode-adapter/src/jsonl.mjs`。
- `--mode rpc` 时跳过普通管道 stdin 读取，stdin 专用作协议通道（`Step-Code/packages/coding-agent/src/main.ts:1329-1336`）。stdout 只写协议行，诊断走 stderr。

### 2.2 命令表（stdin → 响应）

`id` 可选；响应回显同 `id`（`rpc-types.ts:22`；构造 `rpc-mode.ts:64-77`）。类型定义全集：`Step-Code/packages/coding-agent/src/modes/rpc/rpc-types.ts:20-74`。

| 命令 type | 作用 / 响应 data | 出处（rpc-mode.ts） |
| --- | --- | --- |
| `prompt` {message, images?, streamingBehavior?} | preflight 成功后**异步**发响应 | 399-421 |
| `steer` / `follow_up` {message, images?} | 打断改道 / 追加排队 | 423-431 |
| `abort` / `clear_queue` | 中断当前轮 / 清空队列（data 含 steering/followUp） | 433-446 |
| `new_session` {parentSession?} | 新会话（data:{cancelled}） | 433-446 |
| `get_state` | RpcSessionState{model, thinkingLevel, isStreaming, ..., sessionId, messageCount, ...} | 452-468；类型 rpc-types.ts:96-109 |
| `set_model` {provider, modelId} / `cycle_model` / `get_available_models` | 切模型 / 轮换 / 列模型 | 474-495 |
| `set_thinking_level` / `cycle_thinking_level` / `get_available_thinking_levels` | 思考档位 | 501-517 |
| `set_steering_mode` / `set_follow_up_mode` | "all" \| "one-at-a-time" | 523-531 |
| `compact` / `set_auto_compaction` | 压缩上下文 | 537-545 |
| `set_auto_retry` / `abort_retry` | 自动重试 | 551-559 |
| `bash` {command} / `abort_bash` | 执行 shell（data:BashResult） | 565-591 |
| `get_session_stats` / `export_html` / `switch_session` / `fork` / `clone` / `get_fork_messages` / `get_entries` / `get_tree` / `get_last_assistant_text` / `set_session_name` | 会话管理族 | 597-661 |
| `get_messages` / `get_commands` | 全量消息 / 斜杠命令（含扩展命令、prompt 模板、skill:*） | 667-706 |

**响应形状**：`{id?, type:"response", command:<原type>, success:true, data?}` 或 `{..., success:false, error:string}`（`rpc-types.ts:116-239`）。发给它的行不是合法 JSON 时，回 `command:"parse"` 的错误响应（`rpc-mode.ts:748-762`）。

### 2.3 事件流（stdout）

`session.subscribe` 订阅的 AgentSessionEvent 经 `toJsonEvent` 投影逐行输出（`rpc-mode.ts:327-332`）。关键点：

- `message_update` 会剥掉 partial 累计快照，只留增量事件（`Step-Code/packages/coding-agent/src/modes/json-event.ts:46-61`）。
- `toolcall_start` 附加 `id`/`toolName`（`json-event.ts:23-30`）。
- **`agent_settled` 是"一轮结束"的权威信号**——适配层 `waitForIdle()` 就等它（`rpc-client.ts:464-479`）。
- 另有 `bash_execution_update` {id?, delta}（`Step-Code/packages/coding-agent/src/core/agent-session.ts:167`）。

**流式增量全集**（`assistantMessageEvent.type`）：`start / text_* / thinking_* / toolcall_* / done / error`，定义在 `Step-Code/packages/providers/src/types.ts:451-467`。token 级增量就是 `text_delta` {contentIndex, delta}。

### 2.4 扩展 UI 请求/响应（工具批准的载体）

```
CLI → 宿主: {"type":"extension_ui_request","id":"<uuid>","method":"confirm",
             "title":"Approve bash [xxxx]","message":"Call: ...","timeout"?}
宿主 → CLI: {"type":"extension_ui_response","id":"<uuid>","confirmed":true}   // 或 value / cancelled:true
```

- method 全集：`select | confirm | input | editor | notify | setStatus | setWidget | setTitle | set_editor_text`（`rpc-types.ts:246-282`；分发 `rpc-mode.ts:136-314, 764-778`）。后五个是单向 fire-and-forget。
- **超时/abort 默认拒绝（false）**——fail-closed。
- 适配层策略：默认 fail-closed（未注册 handler 时自动回 `{cancelled:true}`，对齐无 UI 默认拒绝）；`--auto-approve 1` 显式切自动放行（仅建议 mock 场景）。

### 2.5 生命周期

- 进程常驻，不自动退出（`rpc-mode.ts:816`）。
- **stdin EOF → flush 后 exit 0**（`rpc-mode.ts:800-803, 721-741`）——适配层 `stop()` 的第一招。
- SIGINT/SIGTERM/SIGHUP → 130/143/129（win32 无 SIGHUP，`rpc-mode.ts:371-385`）。
- 扩展 shutdownHandler 置位后等 `agent_settled` 再退（`rpc-mode.ts:329-331, 743-746`）。

### 2.6 一轮问答时序（rpc，实测 mock 序列）

```
宿主                          step --mode rpc
 │ {"type":"prompt","message":"hi"} ──▶│
 │ ◀── {"type":"response","command":"prompt","success":true}   (preflight 后异步)
 │ ◀── agent_start
 │ ◀── message_start {message:{role:"assistant"}}
 │ ◀── message_update {assistantMessageEvent:{type:"text_start",contentIndex:0}}
 │ ◀── message_update {…text_delta…} ×N            ← token 增量
 │ ◀── message_update {…text_end…}
 │ ◀── message_end
 │ ◀── agent_end
 │ ◀── agent_settled                                ← 一轮结束信号
```

带工具批准的完整时序见 §5.3。

---

## 3. 模式 B：sdk-stdio（长度前缀帧）——未实现，留档

适配层当前未实现此模式；以下笔记供后续接手者使用。权威实现：`Step-Code/packages/coding-agent/src/step/stdio.ts` 与 `stdio-host.ts`；仓库测试 `Step-Code/packages/coding-agent/test/step-stdio-host.test.ts:87-413` 有完整往返序列。

### 3.1 帧格式

- 4 字节大端长度前缀 + UTF-8 JSON 载荷（`encodeStepStdioFrame`，`stdio.ts:142-167`；`STEP_LENGTH_PREFIX_BYTES=4`，`stdio.ts:18`）。
- 最大帧 8MB（`stdio.ts:17`）。EOF 时残留半帧 → `INCOMPLETE_FRAME` 协议违规，exit(1)（`stdio.ts:261-275`）。
- 协议名 `"step-agent-sdk"`、版本 1（`stdio.ts:15-16`）。
- 信封字段：`protocol / version / kind(request|response|event) / id? / method? / replyTo? / sessionId? / turnId? / sequence? / payload? / error?`（`stdio.ts:47-59`）。`turnId` 类型里有但 v1 host 未用（`stdio.ts:55`）。
- 信封校验：request 必须有非空 method；event 必须有非空 method + ≥0 整数 sequence；response 必须有非空 replyTo 且 **payload 与 error 互斥**（`stdio.ts:87-140`）。

### 3.2 initialize 握手时序

```
SDK 客户端                       step --sdk-stdio
 │ {kind:"request",method:"initialize",
 │  payload:{protocolRange:{min:1,max:1}}} ──▶│
 │ ◀─ {kind:"response",replyTo, payload:{
 │      runtimeVersion:"step", selectedProtocol:1,
 │      capabilities:["streaming-input","sdk-tools","permission-callback","hooks","sessions"],
 │      limits:{maxFrameBytes:8388608,maxConcurrentQueries:1}}}
```

- 第一条必须是 initialize，否则 `PROTOCOL_VIOLATION "initialize is required first"`（`stdio-host.ts:312-320`）。
- `protocolRange` 缺省按 {1,1}；min>1 或 max<1 → `PROTOCOL_VERSION_UNSUPPORTED` + close(1)（`stdio-host.ts:392-405`，已抽查核实）。
- 成功响应构造：`stdio-host.ts:407-415`（已抽查核实）。
- 启动时 stdout 原始字节 writer 在 bootstrap 第 1 步就被捕获，帧不会被诊断污染（`Step-Code/apps/cli/src/bootstrap/stdout-capture.ts:21-28`；`apps/cli/src/main.ts:99-100`）。

### 3.3 客户端 → host 请求表

出处均在 `stdio-host.ts`（行号见括号）。

| method | payload 要点 | 响应 payload |
| --- | --- | --- |
| `initialize` | 见 §3.2 | 见 §3.2 |
| `query.start` (418-495) | {prompt?, streamingInput?, options?{permissionMode, hasPermissionCallback, includePartialMessages, model:"provider/id", maxThinkingTokens, maxTurns, outputFormat, sdkTools, hooks, sandbox}} | {queryId:"q_N", sessionId}，随后必发一条 query.message system/init |
| `query.input` (497-517) | {queryId, text \| message}（需 streamingInput:true） | {accepted:true} |
| `query.input_end` (519-533) | {queryId} | {accepted:true} |
| `query.interrupt` (535-544) | {queryId} | {interrupted:true} |
| `query.set_permission_mode` (546-560) | {mode} | {ok, permissionMode} |
| `query.set_model` (886-910) | {model:"provider/id"} | {ok, model} |
| `query.set_max_thinking_tokens` (912-931) | {tokens}（off/minimal/low/medium/high/xhigh 阈值映射 1466-1473） | {ok, applied, level} |
| `query.get_context_usage` (933-941) | — | {input_tokens, max_input_tokens, percent_used} |
| `runtime.supported_models` (943-950) | — | [{id:"provider/id", provider, model, displayName}] |
| `runtime.supported_commands/_agents/account_info`、`mcp.status`、`settings.resolve` (346-381, 943-958) | — | 各自静态形状 |
| `session.list/get/messages/rename/tag/compact` (960-1042) | session.rename 只改名；session.tag 恒 {ok:false,supported:false} | 会话/消息（Anthropic 形状） |
| `runtime.shutdown` (382-385) | — | {ok:true} + close(0) |
| （未知方法）(387) | — | PROTOCOL_VIOLATION |

约束：同一时刻只允许 1 个活跃 query，冲突 → `SESSION_BUSY`（419-422）；`sandbox.enabled:true` → `SANDBOX_UNAVAILABLE`（439-446）；`input_end` 之后再发 `query.input` → `PROTOCOL_VIOLATION`。

### 3.4 host → SDK 事件表

主通道 `kind:"event", method:"query.message"`，payload {queryId, message}，message 形状对齐 Claude Agent SDK（投影 `stdio-host.ts:1044-1156, 1114-1156, 1520-1539`）：

| message.type | 何时 | 出处 |
| --- | --- | --- |
| `system` subtype:"init" | query.start 时 | 418-495 |
| `assistant`（含 content 数组 text/tool_use/thinking、usage） | message_start/end 各一次 | 1114-1156 |
| `stream_event`（content_block_delta / text_delta） | 仅 options.includePartialMessages:true | 1049-1062 |
| `user`（tool_result） | tool_execution_end | 1065-1081 |
| `status`（turn_complete / error） | 每轮收尾 | 582-587, 630-635 |
| `permission_denied` {tool_name, message} | 权限被拒 | 835-841 |
| `result`（subtype: success / error_during_execution；含 session_id, duration_ms, num_turns, result?/errors[]） | query 终态 | 658-682 |

其它 event method：`user_notification`、`ui.status/working/thinking_label/widget/title/editor_text`、`extension_error`（1100-1112, 1190-1208）。

### 3.5 错误码与生命周期

- 错误码集：`PROTOCOL_VIOLATION / FRAME_TOO_LARGE / INCOMPLETE_FRAME / INVALID_UTF8 / INVALID_JSON`（`stdio.ts:64-80`）+ `CONFIG_INVALID / SESSION_BUSY / SESSION_NOT_FOUND / SANDBOX_UNAVAILABLE / MODEL_UNAVAILABLE / PROTOCOL_VERSION_UNSUPPORTED`（stdio-host.ts 各响应点）。
- 退出：`runtime.shutdown`→0；stdin EOF→0；协议违规→1（267-288）；SIGINT/SIGTERM→130/143（290-296）。

---

## 4. 审批与权限流

### 4.1 rpc 模式

- 权限执行器在 beforeToolCall 阶段决定 allow/deny/confirm（`Step-Code/packages/coding-agent/src/step/permissions.ts:537-574`）。
- rpc 模式绑定真实 uiContext（`rpc-mode.ts:336-338`）→ `hasUI()=true`（`Step-Code/packages/coding-agent/src/core/extensions/runner.ts:496-498`）→ confirm 变成 §2.4 的 extension_ui_request 往返（`rpc-mode.ts:142-145`）；超时/abort 默认 false。
- CLI 预置策略：`--approval-mode confirm|auto|strict`、`--non-interactive-approval allow|deny`、`--non-interactive-denial terminate|continue`、`--tool-override tool=allow|confirm|deny`（`Step-Code/packages/coding-agent/src/cli/args.ts:212-274`）。无 UI 时默认 fail-closed（`permissions.ts:548-565`）。

### 4.2 sdk-stdio 模式

- `permissionMode ∈ default | acceptEdits | plan | bypassPermissions | dontAsk`（`stdio-host.ts:47`）。
- query.start 未指定时：有 hasPermissionCallback → "default"，否则 "dontAsk"（433-434）。
- 只读工具（read/grep/find/ls/get_file/search_files）免批（1479-1481）；plan/dontAsk 下需批准的工具直接 block；bypassPermissions 全跳过；acceptEdits 对 edit/write/write_file/edit_file 免批（791-810）。
- `default` + `hasPermissionCallback:true` → 反向请求 `permission.request` {toolName, input, toolUseId, decisionReason, timeoutMs:60000}（812-888），SDK 回 `kind:"response"` replyTo payload `{behavior:"allow"}` 放行；否则/超时 → block + `query.message {type:"permission_denied", ...}`（829-843）。
- 另有四类 hook 反向请求（PreToolUse/PostToolUse/UserPromptSubmit/Stop，845-869, 1452-1458）、`sdk_tool.invoke`（759-789）、扩展原生 confirm 对话框 `user_dialog.request`（1158-1210），往返方式相同。

### 4.3 带批准的一轮时序（rpc，mock 剧本 `mock:confirm` 实测）

```
宿主                                step --mode rpc
 │ {"type":"prompt","message":"mock:confirm"} ──▶│
 │ ◀── {"type":"response","command":"prompt","success":true}
 │ ◀── toolcall_start {id, toolName:"bash"}
 │ ◀── extension_ui_request {id:"u1", method:"confirm", title:"Approve bash…"}
 │      （等待期间事件流不断：bash_execution_update 持续输出）
 │ {"type":"extension_ui_response","id":"u1","confirmed":true} ──▶│
 │ ◀── tool_execution_start → tool_execution_end
 │ ◀── message_end → agent_settled
```

---

## 5. 认证模型（headless 免登录）

- **登录 UI 只在 interactive 启动时触发**（TTY + 无消息 + 非 rpc/json/sdk-stdio；`Step-Code/packages/coding-agent/src/step/login-flow.ts:87-126`）。rpc / sdk-stdio 是 headless，永不弹登录——但有硬门槛：**appMode≠interactive 且解析不到可用模型时直接 exit 1**（`Step-Code/packages/coding-agent/src/main.ts:1362-1365`），模型可用性取决于有凭据的 provider。
- **三条凭据来源（任一即可）**：
  1. 环境变量 `STEP_API_KEY` 或 CLI `--api-key`（`Step-Code/apps/cli/src/main.ts:160-162`；`login-flow.ts:124`）；
  2. 已登录文件 `~/.stepcode/auth.json`（`Step-Code/packages/coding-agent/src/step/auth.ts:15-17`；`STEPCODE_AUTH_PATH` 可覆盖路径；`step login` 交互式写入，非 TTY 下直接拒绝并提示用 STEP_API_KEY，`Step-Code/apps/cli/src/main.ts:538-542`）；
  3. `STEPCODE_CONFIG_PATH` 指向的 JSON 配置注册自定义 provider（baseUrl + apiKey；apiKey 支持 `"$ENV_VAR"` 引用和 `"!"` 前缀；`stepcode-config.ts:51-116`）。
- **配置文件位置**：配置根 `~/.stepcode`（`environment.ts:6,30-37`）；agent 目录 `~/.stepcode/agent`（`STEP_CODING_AGENT_DIR` 覆盖）；会话在 agent/sessions（`STEP_CODING_AGENT_SESSION_DIR` 覆盖，`environment.ts:60-62`）；`config.toml/auth.json/models.json` 在配置根（48-57）；默认 provider 是 step（`STEP_PROVIDER_ID`）。
- **没有真离线模式**——所有 provider 都是 API 型。免 Step 账号的可行替代：`STEPCODE_CONFIG_PATH` 注册 baseUrl 指向本地网关的自定义 provider。
- 以上全部来自源码精读；**真实 CLI 从未在本项目运行过**（无凭据，按约束不碰私有账号）。

---

## 6. 启动命令（spawn）

```bash
# A. rpc 模式（本适配层在用）
node Step-Code/apps/cli/dist/main.js --mode rpc
# 官方 RpcClient 默认 spawn("node", [cliPath, "--mode", "rpc"])，cliPath 默认
# "dist/bundle/step.js"（rpc-client.ts:81-94；该 bundle 已在仓库构建好）
# 可附加：--provider <id> --model <id> --api-key <key>
#         --approval-mode/--non-interactive-approval/--non-interactive-denial/--tool-override
# --mode 只接受 text|json|rpc（args.ts:204-211）

# B. sdk-stdio 模式（未用）
node Step-Code/apps/cli/dist/main.js --sdk-stdio
# 只能从 step 入口启动（main.ts:1367-1371）
```

- `cwd` 决定 agent 会话绑定的 workspace（AgentSession 绑定 cwd）。
- dev 态可用 tsx：`pnpm --dir Step-Code/apps/cli dev -- --mode rpc`。
- ⚠️ dist 是否为最新构建**未验证**（本项目没跑过 CLI）。

---

## 7. 桌面壳门面映射表（zcode-bridge.mjs 已实现）

ZCode Protocol（NDJSON）→ Step rpc 命令的映射，实现见 `packages/stepcode-adapter/bin/zcode-bridge.mjs`；wire 形状工厂见 `src/wire-shapes.mjs`（逐一对齐 `@zcode/shared` zod strict schema；用 `tools/schema-probe.mjs --validate` 校验——样例随 wire-shapes.mjs 增减，以命令实时输出为准，此处不写死数量）。

| ZCode 方法 | 映射到 Step | 备注 |
| --- | --- | --- |
| `provider/updateAccountConfig` | —（接受并回执） | |
| `session/create` | `new_session` + `set_model` | |
| `session/subscribe` | `session.subscribe` 订阅 | |
| `session/send` | `prompt` / `steer` | |
| `session/stop` | `abort` | |
| `session/setModel / setThoughtLevel / setMode` | 对应 set_* | |
| `session/list / messages / events` | `get_state` 族 / `get_messages` / `get_entries` | |
| `mcp/list` | —（空列表） | |
| `v4/connection/flow` | — | |
| `v4/conversation/subscribe / unsubscribe / resync` | 事件投影 | 含 sessions-index / workspace-config topic 初始帧；**snapshot 重放，无增量** |
| `v4/command`（createSession / sendText / stop） | 同 session/* | |
| 未知方法 | — | 回 JSON-RPC `-32601`，host 按可选能力降级 |

事件投影：Step 事件 → legacy `session/event`（turn.started / part.delta / turn.completed）；桌面自动追加的 `--surface desktop` 被门面容忍（忽略未知参数）；stdin EOF → 先优雅杀 Step 子进程（EOF→SIGTERM→SIGKILL）再退出，防 Windows 孤儿进程。

**未映射（诚实清单）**：v4 deltas 增量帧（row.delta）；历史会话冷恢复；`interaction/requestPermission` 反向桥接（Step 的 extension_ui_request 按批准策略处理：默认 fail-closed 拒绝，`--auto-approve 1` 时自动放行）。

---

## 8. 测试与 mock 策略

- **mock 服务器** `packages/stepcode-adapter/mock/step-rpc-mock.mjs`：忠实复刻 rpc wire 行为（无握手、preflight 异步响应、事件形状对齐 json-event.ts 投影、UI 往返、EOF→0、SIGINT→130、非法 JSON→parse 错误）。剧本路由：`hi`（文本问答）/ `mock:tool` / `mock:confirm` / `mock:confirm-timeout` / `mock:error` / `mock:crash` / `mock:exit130`；调试参数 `--hang <cmd>` / `--ignore-eof` / `--delay <ms>`。
- **测试入口**：`node --test stepcode-desktop/packages/stepcode-adapter/test`（目录形式，Node 24 实测 45/45；套件真身在 `suites/*.mjs`、`test/index.js` 只做聚合——原因见 adapter README 的 Node 24 test runner 说明）。
- **冒烟**：`npm run bridge:smoke`（模拟 host 完整调用序列，实测 SMOKE PASS：11 断言、15 帧往返、EOF exit 0）。
- **形状校验**：`npx tsx tools/schema-probe.mjs --validate`（仓库根跑；全样例过 zod strict 才 exit 0——样例数随 wire-shapes.mjs 增减，以命令实时输出为准，不写死数字）。
- **后续校准**：拿真实 CLI 冒烟一次（`STEP_API_KEY` 指向本地网关 + `--mode rpc`）即可对齐 mock 与真实的差异——这是当前最大的未验证面。
- **佐证测试**（Step-Code 仓库内）：`rpc.test.ts`、`rpc-prompt-response-semantics.test.ts`、`rpc-client-process-exit.test.ts`、`rpc-jsonl.test.ts`、`step-stdio-host.test.ts:87-413`。

---

## 9. 出处速查索引

| 主题 | 文件（相对工作区根） |
| --- | --- |
| rpc 协议头注释 / 输入循环 | `Step-Code/packages/coding-agent/src/modes/rpc/rpc-mode.ts:1-12, 805-813` |
| rpc 命令/响应/事件分发 | `rpc-mode.ts:399-778` |
| rpc 类型定义 | `Step-Code/packages/coding-agent/src/modes/rpc/rpc-types.ts` |
| JSONL 编解码 | `Step-Code/packages/coding-agent/src/modes/rpc/jsonl.ts` |
| 事件投影（剥 partial 等） | `Step-Code/packages/coding-agent/src/modes/json-event.ts` |
| 官方 RpcClient spawn 约定 | `Step-Code/packages/coding-agent/src/modes/rpc/rpc-client.ts:81-94, 464-479` |
| CLI 参数（--mode/--approval-* 等） | `Step-Code/packages/coding-agent/src/cli/args.ts:204-274` |
| 权限执行器 | `Step-Code/packages/coding-agent/src/step/permissions.ts:537-574` |
| sdk-stdio 帧格式/信封/错误码 | `Step-Code/packages/coding-agent/src/step/stdio.ts` |
| sdk-stdio host（initialize/方法面/投影） | `Step-Code/packages/coding-agent/src/step/stdio-host.ts` |
| sdk-stdio 仓库测试 | `Step-Code/packages/coding-agent/test/step-stdio-host.test.ts:87-413` |
| 登录触发条件 | `Step-Code/packages/coding-agent/src/step/login-flow.ts:87-126` |
| auth.json 路径 | `Step-Code/packages/coding-agent/src/step/auth.ts:15-17` |
| 自定义 provider 配置 | `Step-Code/packages/coding-agent/src/step/stepcode-config.ts:51-116` |
| 配置目录体系 | `Step-Code/packages/coding-agent/src/step/environment.ts` |
| headless 模型门槛 | `Step-Code/packages/coding-agent/src/main.ts:1329-1379, 1362-1365` |
| 流式事件类型全集 | `Step-Code/packages/providers/src/types.ts:451-467` |
| 桌面壳开关 | `stepcode-desktop/packages/desktop/src/main/stepcodeBackend.ts` |
| 门面进程 | `stepcode-desktop/packages/stepcode-adapter/bin/zcode-bridge.mjs` |
