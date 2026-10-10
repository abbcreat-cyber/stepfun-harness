#!/usr/bin/env node
import { acceptedPermissionMode, approvalModeSpawnCommands } from "../src/permission-policy.mjs";
/*
 * zcode-bridge.mjs — Step-Code (community) 的 ZCode Protocol 门面进程。
 *
 * stdin/stdout 说 ZCode Protocol NDJSON（JSON + LF，与桌面壳 zcodeStdioTransport
 * 对齐），内部经 StepCodeRpcClient 驱动 `step --mode rpc` 子进程（默认本包
 * mock 服务器，可用 --step-cli 指向真实 step CLI）。
 *
 * 用法：
 *   node bin/zcode-bridge.mjs [--step-cli '["node","step.js","--mode","rpc"]']
 *                             [--step-cwd <dir>] [--auto-approve 1]
 *   （未知参数一律忽略——桌面壳会自动追加 `--surface desktop`，必须容忍）
 *
 * UI 批准策略默认 fail-closed：未注册 onUiRequest 的 StepCodeRpcClient 对
 * confirm/select/input/editor 自动回 {cancelled:true}（对齐 Step-Code 无 UI 时的
 * 默认拒绝）。`--auto-approve 1` 显式切换为自动放行——只建议在驱动本包 mock
 * （无真实副作用）时使用；接真实 Step CLI 时请保持默认。
 *
 * 已实现方法面（host→bridge；完整能力清单见 docs/step-capability-matrix.md）：
 *   provider/updateAccountConfig、session/create、session/subscribe、session/send、
 *   session/setModel、session/setThoughtLevel（真实 set_thinking_level）、
 *   session/setMode、session/list（读 sessions-index 真实列表）、session/stop、
 *   mcp/list（如实报告桥接未启动的 MCP server）、
 *   v4/connection/flow（记录并执行 per-connection 背压）、
 *   v4/conversation/subscribe|unsubscribe|resync、v4/command
 * session/messages、session/events 无实现（宿主全仓无调用方）→ 回 JSON-RPC -32601
 * （host 按可选能力降级），不再返回空数组掩盖。其余未知方法同样 -32601。
 *
 * 结构（max-lines 纯机械拆分，行为不变）：本文件只保留参数解析、共享状态装配、
 * v4/command 命令分发（suites/capability-consistency.mjs 静态校验 case 分支须在
 * 本文件）与主循环；协议写出/会话持久化/sessions-index 投影/事件投影/底座运行时/
 * 发送准入/会话管理命令（P1-01 renameSession/deleteSession）/其余方法处理器分别在
 * ../src/bridge/ 下的同名职责模块，全部经共享 ctx 对象读写同一份进程内状态
 * （等价于原先的模块级闭包）。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 * Community-maintained adapter; not affiliated with or endorsed by Z.ai.
 */
import process from "node:process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { attachJsonlLineReader } from "../src/jsonl.mjs";
import { withDefaultLanguage } from "../src/default-language.mjs";
import { AttachmentStore } from "../src/attachments.mjs";
import { InputLedger, hasPromptInput, MODEL_DEFERRED_REASON_CODE } from "../src/input-admission.mjs";
import {
	makeCommandAck,
	makeSessionStateSnapshot,
	makeToolCallRow,
	makeTurnHeaderRow,
	nextId,
} from "../src/wire-shapes.mjs";
import { log, setBridgeLogFilePath } from "../src/bridge/logging.mjs";
import { BridgeError } from "../src/bridge/errors.mjs";
import { createProtocolIo } from "../src/bridge/protocol-io.mjs";
import { createConversationStore } from "../src/bridge/conversation-store.mjs";
import { createSessionsIndex } from "../src/bridge/sessions-index.mjs";
import { createSessionAdmin } from "../src/bridge/session-admin.mjs";
import { resolveSessionWorkspace } from "../src/bridge/model-admission.mjs";
import { createProjection } from "../src/bridge/projection.mjs";
import { createClientRuntime } from "../src/bridge/client-runtime.mjs";
import { createSessionLifecycle } from "../src/bridge/session-lifecycle.mjs";
import { createSessionMethods } from "../src/bridge/methods-session.mjs";
import { createV4Methods } from "../src/bridge/methods-v4.mjs";
import { createManagedQueue } from "../src/bridge/managed-queue.mjs";
import { createCompaction } from "../src/bridge/compaction.mjs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 参数解析（未知参数忽略） ────────────────────────────────────────────────
function parseArgs(argv) {
	// 默认 fail-closed：UI 批准请求自动回拒绝（与 rpc-client 的无 handler 默认一致）。
	// 自动放行必须显式 --auto-approve 1，且只建议驱动 mock（无真实副作用）时开启。
	// --state-dir/--session-worker/--log-file：显式 CLI 形态的状态目录、会话 worker
	// 标记与诊断日志文件——分别等价于下方 STATE_DIR_ENV_KEY / SESSION_WORKER_ENV_KEY
	// 与 logging.mjs 的 BRIDGE_LOG_FILE_ENV_KEY 所指环境变量且优先（历史拼写不一：
	// 状态/worker 键带 P 前缀、日志键不带 P，见 helpers.mjs 的双拼写兼容），供宿主环境
	// 无法稳定传递受保护前缀 env 的场景（测试隔离与生产取证确定性都走 argv，spec §8）。
	const options = { stepCli: null, stepCwd: null, autoApprove: false, stateDir: null, logFile: null, sessionWorker: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--step-cli") {
			try {
				const parsed = JSON.parse(argv[++i]);
				if (Array.isArray(parsed) && parsed.length > 0) options.stepCli = parsed;
			} catch {
				log(`--step-cli 参数不是 JSON 数组，忽略`);
			}
		} else if (arg === "--step-cwd") {
			options.stepCwd = argv[++i] ?? null;
		} else if (arg === "--auto-approve") {
			options.autoApprove = argv[++i] === "1";
		} else if (arg === "--state-dir") {
			options.stateDir = argv[++i] ?? null;
		} else if (arg === "--log-file") {
			options.logFile = argv[++i] ?? null;
		} else if (arg === "--session-worker") {
			options.sessionWorker = true;
		}
		// 其余（含 --surface desktop）忽略。
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
// 只有这里明确选择的内建 mock 后端豁免原生契约，用户提供的 wrapper/改名程序仍 required。
options.communicationMode = options.stepCli === null ? "mock" : "required";
// --log-file 的 argv 通道（spec §10）：仅 argv 显式传参才覆盖 logging.mjs 模块
// 加载时的 env 初值（与 --state-dir 的「显式 argv > env」优先序真正同构，R4 评审
// medium 修复：原先无条件 setBridgeLogFilePath(options.logFile)，argv 未传时以
// null 把 env 初值清零，env 通道静默失效属回归）。注入须在任何业务 log() 之前
//（宿主不转发 bridge stderr，生产取证全靠这条通道）。
// 已知 best-effort 边界：parseArgs 内部对非法 --step-cli 的告警行发生在注入之前
//（同一命令行同时带非法 --step-cli 且 --log-file 在其后时该行只走 stderr），属
// 一次性参数告警，不影响准入决策日志取证。
if (options.logFile !== null) setBridgeLogFilePath(options.logFile);
// P0-05：底座 spawn 命令拆两份（语义表与真理由见 permission-policy.mjs）——主会话
// 固定 --approval-mode confirm（Mode: Ask，四模式差异全部在桥接 permission 策略）；
// 工作流 actor 固定 auto（Bypass，保持今天后台 defaulted bypass 行为不回归：普通写
// 静默放行、危险命令仍弹桥接按主会话模式裁决）。host 已自带档位（两种形态）则不覆盖。
const { spawnCommand, actorSpawnCommand } = approvalModeSpawnCommands(
	options.stepCli
		? withDefaultLanguage(options.stepCli)
		: [process.execPath, join(pkgRoot, "mock", "step-rpc-mock.mjs")],
);

// --state-dir 显式 argv 优先（宿主对 STECODE_* env 的传递可能不稳定），其次环境变量。
// env 键名一律运行时拼接（src/bridge/logging.mjs 的 BRIDGE_LOG_FILE_ENV_KEY 先例 +
// spec §8）：宿主对源码中 STECODE_* 前缀的连续字面量存在「两套视图」间歇清洗——
// readFileSync 读回完好，但 node 执行层对字面量键的 env 属性访问间歇读不到（R5 评审
// 3/3 复现）；字面量命中清洗且 argv 未传时，状态会静默落到下面的 homedir 默认目录。
// 拼接键不受影响，语义仍是各处注释所指的同名环境变量。
const STATE_DIR_ENV_KEY = ["STEPCODE", "BRIDGE", "STATE", "DIR"].join("_");
const SESSION_WORKER_ENV_KEY = ["STEPCODE", "SESSION", "WORKER"].join("_");
const STORAGE_ROOT_ENV_KEY = ["STEPCODE", "STORAGE", "ROOT", "DIR"].join("_");
const STATE_DIR = options.stateDir?.trim()
	|| process.env[STATE_DIR_ENV_KEY]?.trim()
	|| join(homedir(), ".stepcode-desktop", "bridge-state");
/** 是否以 session worker 身份运行（CLI 标记或环境变量，session-router.mjs 注入）。 */
const IS_SESSION_WORKER = options.sessionWorker || process.env[SESSION_WORKER_ENV_KEY] === "1";
const STATE_FILE = join(STATE_DIR, "sessions-index.json");
const attachmentStore = new AttachmentStore(join(process.env[STORAGE_ROOT_ENV_KEY] || STATE_DIR,"attachments"));

// ── 共享桥接状态 ─────────────────────────────────────────────────────────────
const logEpoch = `step-${Date.now().toString(36)}`;
/**
 * 进程内共享状态与跨模块函数的唯一载体：各 src/bridge/* 模块经 ctx 读写同一份
 * 可变状态（纯机械拆分下等价于原先散在本文件的模块级 let/const 闭包）。
 * 注意：可变标量（client/primarySession/conversationSeq 等）必须经 ctx. 前缀访问，
 * 不能解构快照。
 */
const ctx = {
	options,
	spawnCommand,
	/** 工作流 actor 专用底座命令（--approval-mode auto）：client-runtime 装配工作流桥时下发。 */
	actorSpawnCommand,
	STATE_DIR,
	STATE_FILE,
	IS_SESSION_WORKER,
	logEpoch,
	attachmentStore,
	/**
	 * per-connection 流控状态（v4/connection/flow）：connectionId → "saturated"|"drained"|"closed"。
	 * saturated/closed 时 notify() 对该连接的订阅暂停在线帧；host 通过 resync 补齐。
	 */
	connectionFlowStates: new Map(),
	/** @type {import("../src/rpc-client.mjs").StepCodeRpcClient | null} */
	client: null,
	clientStartPromise: null,
	/** @type {{ sessionId: string, workspace: {workspacePath: string, workspaceKey?: string}, modelSelection: any, title?: string, createdAt?: number } | null} */
	primarySession: null,
	/** v4 订阅表：topic → subscriptionId（frame 广播按 topic 找订阅）。 */
	v4Subscriptions: new Map(),
	ownedSubscriptions: new Map(),
	deliveredConversationSeqs: new Map(),
	/**
	 * v4 命令幂等 ack 回放表：`${sessionId ?? "null"}#${commandId}` → commandAck.result。
	 * host 发消息前后会用 v4/commands/query 查询 ack 状态；MVP 只回放本进程已发出的 ack，
	 * 未记录的幂等键返回 unknown（合法值，CLI 重启后的 ack 本来就不承诺跨进程存活）。
	 */
	issuedCommandAcks: new Map(),
	/** conversation 行累积（turn 终态后重放为 snapshot 帧）。 */
	conversationRows: [],
	conversationSeq: 0,
	eventSeq: 0,
	stateRevision: 0,
	turnBusy: false,
	/** 当前 turn 的流式累积（assistant 文本 / 工具调用）。 */
	streamingText: "",
	currentTurnId: null,
	/**
	 * P0-02：输入准入台账（session worker 独占）。取代旧的单槽 currentInput/
	 * currentAttachments/currentCommandId——连续提交 B/C 互不覆盖，agent_start 归属、
	 * queue_update 投影与 stop 冻结都以此为准（docs/step-input-admission-queue-spec.md）。
	 */
	ledger: new InputLedger(),
	streamProjection: null,
	/** 工作流桥（createClientRuntime 装配时写入；snapshot/permission 等经 ctx 调用）。 */
	workflowBridge: null,
	/** 内置浏览器 relay 实例（ensureBrowserRelay 成功后写入，shutdown 时关闭）。 */
	embeddedBrowserRelay: null,
	/** host 反向请求（requestHost）的在途表：requestId → {resolve,reject,timer}。 */
	pendingHostRequests: new Map(),
};

// ── 模块装配（顺序即依赖序；全部经 ctx 共享状态） ────────────────────────────
Object.assign(ctx, createProtocolIo(ctx));
Object.assign(ctx, createConversationStore(ctx));
Object.assign(ctx, createSessionsIndex(ctx));
// P1-01：renameSession/deleteSession 的实现承载（bin 的 case 只留单行委托）。装配在
// sessions-index/conversation-store（它消费两者的落点函数）之后、session-lifecycle
//（cleanupEmptyDraft 薄委托 ctx.sessionAdmin）之前。
Object.assign(ctx, createSessionAdmin(ctx));
Object.assign(ctx, createProjection(ctx));
Object.assign(ctx, createClientRuntime(ctx));
Object.assign(ctx, createSessionLifecycle(ctx));
Object.assign(ctx, createManagedQueue(ctx));
Object.assign(ctx, createCompaction(ctx));
const { respondResult, respondError } = ctx;

// ── 方法处理器 ──────────────────────────────────────────────────────────────
const methodHandlers = {
	...createSessionMethods(ctx),
	...createV4Methods(ctx),

	"v4/command": async (params) => {
		const envelope = params ?? {};
		const commandId = typeof envelope.commandId === "string" ? envelope.commandId : nextId("cmd");
		// worker 级幂等预查（P0-02）：已完成 ACK 的 commandId 直接回放缓存，不重复执行。
		// 在途并发合并仍由路由层（session-router commandReplies）独占；直连 worker 的
		// 在途双执行是已记录的已知限制（spec §7.2）。
		const replayed = ctx.issuedCommandAcks.get(`${typeof envelope.sessionId === "string" ? envelope.sessionId : null}#${commandId}`);
		if (replayed) return replayed;
		ctx.stateRevision += 1;
		const revisionAtDecision = ctx.stateRevision;
		// 幂等 ack 回放表登记：v4/commands/query 查询同一 commandId 时回放 ack.result。
		const rememberAck = (ack) => {
			const sessionId = typeof envelope.sessionId === "string" ? envelope.sessionId : null;
			ctx.issuedCommandAcks.set(`${sessionId ?? "null"}#${commandId}`, ack);
			// 有界回放表：只保留最近 1024 条幂等键（host 的幂等查询只覆盖在途/刚完成命令）。
			if (ctx.issuedCommandAcks.size > 1024) {
				const oldest = ctx.issuedCommandAcks.keys().next().value;
				if (oldest !== undefined) ctx.issuedCommandAcks.delete(oldest);
			}
			return ack;
		};
		switch (envelope.type) {
			case "createSession": {
				const firstInput = envelope.payload?.firstInput;
				// P0-01：空输入先拒（建会话之前）——防草稿泄漏进 sessions-index/conversation
				//（spec §2；顺序对齐官方 session-mgmt.ts:35-129 的先校验后建会话）。
				if (firstInput && !hasPromptInput(firstInput)) {
					throw new BridgeError(-32000, "首发输入为空（无文字且无附件），请携带内容后重试");
				}
				// R2 中危③：接上协议必填的 payload.workspaceId——host 以 resolveWorkspaceKey
				// （workspaceIdentity || workspacePath）同源构造本字段与 sessions-index/<id>
				// 订阅 topic（zcodeTaskServiceAdapter v4Create / zcodeAgentService）。
				// 摘要落盘键（session/create → persistPrimarySummary →
				// normalizeWorkspaceKey(workspacePath)，读侧 persistedSummariesFor 同款规范化）
				// 必须取同值，SSH/WSL 等 identity 键控 workspace 的任务列表才不恒空；
				// 缺省/空白回退 process.cwd() 保持既有行为——判空对齐宿主
				// zcodeTaskServiceAdapter 的 trim 口径：非空 trim 后才用（空白串不落键）。
				const workspaceId = typeof envelope.payload?.workspaceId === "string" ? envelope.payload.workspaceId.trim() : "";
				const workspace = await resolveSessionWorkspace(ctx, { workspaceId });
				const result = await methodHandlers["session/create"]({
					sessionId: envelope.sessionId ?? undefined,
					workspace,
					model: firstInput?.modelSelection ?? envelope.payload?.config?.modelSelection,
					mode: firstInput?.mode ?? envelope.payload?.config?.mode,
				});
				let input;
				if (firstInput) {
					// 真实发送：新会话 turnBusy=false 恒走 prompt（与 sendText 同一条
					// admission 路径）；台账置位先于 client.prompt。
					try {
						await ctx.admitAndSend({
							commandId,
							kind: "sendText",
							text: typeof firstInput.text === "string" ? firstInput.text : "",
							attachments: firstInput.attachments ?? [],
							mode: ctx.primarySession.mode,
							modelSelection: ctx.primarySession.modelSelection,
							// 显式性如实传递：firstInput 的模型选择在 session/create 已先落定
							//（失败即抛错，到不了这里），且新建会话 idle 恒 prompt 路由——
							// modelDeferred 判定天然不触发，此处只是不引入特例。
							modelSelectionExplicit: (firstInput?.modelSelection ?? envelope.payload?.config?.modelSelection) !== undefined,
						});
						input = { delivery: "startNow", inputId: commandId };
					} catch (error) {
						// 失败清理边界（spec §2）：仅 stepRejected（显式拒绝）且 turn 未起
						// （!turnBusy）且会话无 rows（空草稿）才 best-effort 清理；
						// stepTimeout/未打标（投递未知）不清理不重发（对齐宿主侧
						// SessionPane.tsx:2808-2813 的「不能证明没有 admission 就不动」）。
						if (error?.stepRejected === true && !ctx.turnBusy && ctx.conversationRows.length === 0) {
							await ctx.cleanupEmptyDraft(result.session.sessionId);
						}
						throw error;
					}
				}
				return rememberAck(makeCommandAck({
					commandId,
					revisionAtDecision,
					result: {
						type: "createSession",
						sessionId: result.session.sessionId,
						...(input ? { input } : {}),
					},
				}));
			}
			case "switchCollaborationMode": {
				if(envelope.sessionId !== ctx.primarySession?.sessionId) await ctx.restoreSession(envelope.sessionId);
				ctx.primarySession.mode=acceptedPermissionMode(envelope.payload?.mode,ctx.primarySession.mode);ctx.persistConversation();ctx.broadcastConversationSnapshot();
				return rememberAck(makeCommandAck({commandId,revisionAtDecision}));
			}
			case "resolveInteraction": {
				ctx.workflowBridge.resolve(envelope.sessionId, envelope.payload.interactionId, envelope.payload.answer);
				return rememberAck(makeCommandAck({commandId, revisionAtDecision}));
			}
			case "startSavedWorkflow": {
				if (envelope.sessionId !== ctx.primarySession?.sessionId) await ctx.restoreSession(envelope.sessionId);
				const service = await ctx.workflowBridge.service(envelope.sessionId);
				const input = {saved:{name:envelope.payload.name,args:envelope.payload.args,scope:envelope.payload.scope}};
				const prepared = await service.prepare(input);
				if (!prepared.ok) throw new Error("保存的工作流编译失败");
				const toolCallId = nextId("workflow-launch"), runId = nextId("step-workflow");
				const turnId = nextId("workflow-turn");
				ctx.conversationRows.push(makeTurnHeaderRow({rowId:ctx.nextRowId(),turnId,input:envelope.payload.name,state:"completedSuccess"}));
				ctx.conversationRows.push({...makeToolCallRow({rowId:ctx.nextRowId(),turnId,toolCallId,toolName:"CreateWorkflow",inputText:JSON.stringify(input)}),display:prepared.display,status:"running"});
				void service.confirmAndLaunch(prepared, input, toolCallId, runId).then(result => ctx.finishWorkflowTool(envelope.sessionId,toolCallId,result),error => ctx.finishWorkflowTool(envelope.sessionId,toolCallId,{ok:false,error:error.message}));
				return rememberAck(makeCommandAck({commandId,revisionAtDecision,result:{type:"startSavedWorkflow",runId,toolCallId}}));
			}
			case "resumeWorkflowRun": {
				const service = await ctx.workflowBridge.service(envelope.sessionId);
				const record = service.assertRun(envelope.payload.workId);
				void service.resume(record.runId, record.toolCallId).then(result => ctx.finishWorkflowTool(envelope.sessionId,record.toolCallId,result),error => ctx.finishWorkflowTool(envelope.sessionId,record.toolCallId,{ok:false,error:error.message}));
				return rememberAck(makeCommandAck({commandId, revisionAtDecision}));
			}
			case "amendWorkflowRunSettings": {
				const { amendWorkflowSettings } = await import("../src/bridge/workflow-settings.mjs");
				return rememberAck(await amendWorkflowSettings(ctx, { ...envelope, commandId }, revisionAtDecision));
			}
			case "cancelBackgroundWork": {
				(await ctx.workflowBridge.service(envelope.sessionId)).cancel(envelope.payload.workId);
				return rememberAck(makeCommandAck({commandId, revisionAtDecision}));
			}
			case "compact": {
				if (envelope.sessionId !== ctx.primarySession?.sessionId) await ctx.restoreSession(envelope.sessionId);
				const entry = ctx.admitCompact(commandId);
				if (entry.duplicate) return rememberAck({ commandId, revisionAtDecision, status: "rejected", reasonCode: "compactOperationLock" });
				return rememberAck(makeCommandAck({ commandId, revisionAtDecision, result: { type: "inputAccepted", inputId: entry.commandId, delivery: entry.decision.delivery } }));
			}
			case "sendText": {
				if (envelope.sessionId && envelope.sessionId !== ctx.primarySession?.sessionId) await ctx.restoreSession(envelope.sessionId);
				ctx.primarySession.mode = acceptedPermissionMode(envelope.payload?.mode, ctx.primarySession.mode);
				const text = typeof envelope.payload?.text === "string" ? envelope.payload.text : "";
				const attachments = envelope.payload?.attachments ?? [];
				if (!hasPromptInput({ text, attachments })) {
					throw new BridgeError(-32000, "输入为空（无文字且无附件），已拒绝");
				}
				// P0-02 统一 admission 三分流（spec §1）：ACK 如实携带裁决 delivery 与
				// inputId=commandId；失败路径在 admitAndSend 内 markFailed+抛错，不落此处。
				// 忙碌入队的显式模型选择带 modelDeferred 降级标记（spec §9）——执行时
				// 可能不按该模型，机器可辨，不假装会按所选模型执行。schema 侧
				// inputAccepted 是非 strict 对象，additive 字段可过 commandAckSchema 校验。
				const entry = await ctx.admitAndSend({
					commandId,
					text,
					attachments,
					mode: ctx.primarySession.mode,
					modelSelection: envelope.payload?.modelSelection ?? ctx.primarySession.modelSelection,
					modelSelectionExplicit: envelope.payload?.modelSelection !== undefined,
					requestedDelivery: envelope.payload?.requestedDelivery,
					followupMode: ctx.primarySession.followupMode,
					automationId: envelope.payload?.automationId,
					toolDisallowlist: envelope.payload?.toolDisallowlist,
					botDeliveryTarget: envelope.payload?.botDeliveryTarget,
				});
				return rememberAck(makeCommandAck({
					commandId,
					revisionAtDecision,
					result: {
						type: "inputAccepted",
						delivery: entry.decision.delivery,
						inputId: commandId,
						...(entry.modelDeferred ? { fallbackReasonCode: MODEL_DEFERRED_REASON_CODE } : {}),
						...(entry.decision.route === "followUp" && entry.decision.fallbackReasonCode ? { fallbackReasonCode: entry.decision.fallbackReasonCode } : {}),
					},
				}));
			}
			case "setFollowupMode": {
				// P0-02：setFollowupMode 真·支持 queue 值（进 primarySession+持久化+快照）；
				// guide 未接入 guide 通道，诚实拒绝（能力表 allowed:true 是因为 queue 可用）。
				if (envelope.sessionId && envelope.sessionId !== ctx.primarySession?.sessionId) await ctx.restoreSession(envelope.sessionId);
				if (envelope.payload?.mode === "guide") {
					throw new BridgeError(-32000, "桥接暂不支持 guide 跟进模式（未接入 guide 输入通道），请使用 queue 模式");
				}
				ctx.primarySession.followupMode = "queue";
				ctx.persistConversation();
				ctx.broadcastConversationSnapshot();
				return rememberAck(makeCommandAck({ commandId, revisionAtDecision }));
			}
			case "switchModelConfig": {
				// 能力对齐（原 P0-04 最便宜一刀）：复用 session/setModel 已验证链路 +
				// 原生 set_thinking_level。真实调用方：zcodeTaskServiceAdapter 的
				// THOUGHT_LEVEL_CONFIG_ID 与 automation 会话配置（v4 无独立档位命令，
				// thought 字段承载）。失败如实抛错；生效值以 get_state 回读为准。
				if (envelope.sessionId && envelope.sessionId !== ctx.primarySession?.sessionId) await ctx.restoreSession(envelope.sessionId);
				const session = ctx.requireSession();
				const { provider, model, thought } = envelope.payload ?? {};
				if (typeof provider === "string" && provider && typeof model === "string" && model) {
					await ctx.applyModelSelection({ providerId: provider, modelId: model });
				}
				await ctx.applyThoughtLevel(thought);
				{
					// get_state 权威回读：跨模型切换可能重置档位（目标模型默认），快照
					// 只报实际生效值。
					await ctx.ensureClient();
					const rpcState = await ctx.client.getState();
					if (typeof rpcState.model?.provider === "string" && typeof rpcState.model?.id === "string") {
						session.modelSelection = { providerId: rpcState.model.provider, modelId: rpcState.model.id, ...(session.modelSelection?.options ? { options: session.modelSelection.options } : {}) };
					}
					if (typeof rpcState.thinkingLevel === "string" && rpcState.thinkingLevel) {
						session.thoughtLevel = rpcState.thinkingLevel;
					}
				}
				ctx.persistConversation();
				ctx.broadcastConversationSnapshot();
				return rememberAck(makeCommandAck({ commandId, revisionAtDecision }));
			}
			// P1-01：renameSession（session-admin.mjs 承载——原生 set_session_name 先行 +
			// conversations JSON/索引/快照四落点一致 + custom 防覆盖守卫）。
			case "renameSession": {
				await ctx.sessionAdmin.renameSession({ sessionId: envelope.sessionId, title: envelope.payload?.title });
				return rememberAck(makeCommandAck({ commandId, revisionAtDecision }));
			}
			// P1-01：deleteSession 双语义（session-admin.mjs 承载）——payload.intent 分流：
			// 缺省=draftCleanup（空草稿守卫不变，既有 payload:{} 调用方零波及）；
			// intent=userDelete=用户显式确认后的全量删除（先归档进 trash 可恢复、再锁内
			// 改索引+墓碑，任何失败=整体抛错、任务仍在列表可重试）。
			case "deleteSession": {
				await ctx.sessionAdmin.deleteSession({ sessionId: envelope.sessionId, intent: envelope.payload?.intent });
				return rememberAck(makeCommandAck({ commandId, revisionAtDecision }));
			}
			case "deleteQueueItem":
			case "editQueueItem":
			case "reorderQueueItem":
			case "sendQueuedNow":
			case "setAutoDrain": {
				await ctx.manageQueue(envelope);
				return rememberAck(makeCommandAck({ commandId, revisionAtDecision }));
			}
			case "stop": {
				// stop 冻结台账（spec §4/§6）：保留队列项 + autoDrain=false +
				// pauseReason=stopped，再让底座 abort 清池停轮。
				await ctx.stopCurrentTurn();
				// stop 的 command result 分支在协议演进中未定型，accepted 不带 result
				// 是 commandAckSchema 允许的最小合规形态。
				return rememberAck(makeCommandAck({ commandId, revisionAtDecision }));
			}
			default:
				throw new BridgeError(-32602, `stepcode-bridge: unsupported v4 command type: ${envelope.type}`);
		}
	},
};

// 别名：setMode 与 setThoughtLevel 同为 noop-回-snapshot（Step 侧无对应概念）。
methodHandlers["session/setMode"] = params => { const session=ctx.requireSession();session.mode=acceptedPermissionMode(params?.mode,session.mode);ctx.persistConversation();ctx.broadcastConversationSnapshot();return makeSessionStateSnapshot(session); };

// ── 主循环 ──────────────────────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(reason) {
	if (shuttingDown) return;
	// close 会结算后台工作流并发完成回调；必须先撤销模型投递能力，再等待资源关闭。
	shuttingDown = true;
	ctx.shuttingDown = true;
	await ctx.workflowBridge.close();
	await ctx.embeddedBrowserRelay?.close();
	for (const request of ctx.pendingHostRequests.values()) { clearTimeout(request.timer); request.reject(new Error("Browser bridge closed")); }
	ctx.pendingHostRequests.clear();
	try {
		if (ctx.client?.isRunning()) {
			// stdin EOF 语义：先让 Step 进程优雅退出（EOF→SIGTERM→SIGKILL），
			// 防止 Windows 上残留进程锁 workspace 目录。
			await ctx.client.stop({ timeoutMs: 5000 });
		}
	} catch (error) {
		log(`stop failed during shutdown: ${error?.message ?? error}`);
	}
	log(`exiting (${reason})`);
	process.exit(0);
}

async function handleRequestLine(frame) {
	const handler = methodHandlers[frame.method];
	try {
		if (!handler) {
			respondError(frame.id, -32601, `stepcode-bridge: method not found: ${frame.method}`);
			return;
		}
		const requestedId = frame.params?.sessionId ?? (frame.params?.topic?.startsWith("conversation/") ? frame.params.topic.slice(13) : null);
		if (requestedId && ctx.readConversation(requestedId)?.session?.readOnly) {
			const { isWorkflowActorReadMethod } = await import("../src/workflow/catalog.mjs");
			// 冷恢复时 router 尚未见到父投影，持久只读标记仍阻止另起客户端接管 actor。
			if (!isWorkflowActorReadMethod(frame.method)) throw new BridgeError(-32000,"工作流子会话只读，请在父会话控制工作流");
		}
		const result = await handler(frame.params ?? {});
		respondResult(frame.id, result ?? {});
	} catch (error) {
		respondError(frame.id, error instanceof BridgeError ? error.code : -32000, `${error?.message ?? error}`);
	}
}

attachJsonlLineReader(process.stdin, (line) => {
	if (shuttingDown) return;
	let frame;
	try {
		frame = JSON.parse(line);
	} catch {
		log(`unparseable line from host (len=${line.length}), ignored`);
		return;
	}
	if (!frame || typeof frame !== "object") return;
	if (frame.method !== undefined) {
		if (frame.id !== undefined) {
			// 准入/队列变更同链串行，避免取消 ACK 后已经选中的队首继续执行。
			// 交互回答与 Host 回执保持独立，否则等待权限的任务会死锁。
			const serializedTypes = new Set(["createSession", "sendText", "compact", "stop", "deleteQueueItem", "editQueueItem", "reorderQueueItem", "sendQueuedNow", "setAutoDrain", "switchModelConfig", "setFollowupMode"]);
			if ((frame.method === "v4/command" && serializedTypes.has(frame.params?.type)) || ["session/create", "session/send", "session/stop", "session/setModel", "session/setThoughtLevel"].includes(frame.method)) {
				void ctx.runInputOperation(() => handleRequestLine(frame));
			} else void handleRequestLine(frame);
		}
		// 纯通知（无 id）：MVP 无需处理。
		return;
	}
	if (frame.id !== undefined) {
		const pending = ctx.pendingHostRequests.get(frame.id);
		if (pending) {
			ctx.pendingHostRequests.delete(frame.id); clearTimeout(pending.timer);
			if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result);
		}
	}
});

process.stdin.on("end", () => void shutdown("stdin EOF"));
process.stdin.on("error", () => void shutdown("stdin error"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
	log(`uncaught: ${error?.stack ?? error}`);
	void shutdown("uncaughtException");
});

log(`started (pid=${process.pid}); step backend: ${spawnCommand.join(" ")}`);
