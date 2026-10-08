/*
 * 方法处理器·会话面（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）：
 * session/create|subscribe|send|setModel|setThoughtLevel|read|list|stop、
 * mcp/list、provider/workspace 面、v4/usage/stats、v4/commands/query、plugins 面。
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { acceptedPermissionMode } from "../permission-policy.mjs";
import { createStepPluginHandlers } from "../plugins.mjs";
import { readPluginRuntimeStatuses } from "../plugin-runtime-status.mjs";
import { buildUsageSnapshot, readUsageSessions } from "../usage-stats.mjs";
import { workflowSlashCommands } from "../workflow/catalog.mjs";
import { classifyStepSendError } from "../step-send-errors.mjs";
import { hasPromptInput, sanitizeModelSelection } from "../input-admission.mjs";
import {
	COMMUNITY_BACKEND_LABEL,
	defaultModelSelection,
	makeSessionStateSnapshot,
	nextId,
} from "../wire-shapes.mjs";
import { log } from "./logging.mjs";
import { BridgeError } from "./errors.mjs";
import { testProviderConnectivity } from "./provider-connectivity.mjs";
import { resolveSessionWorkspace } from "./model-admission.mjs";

/** @param {any} ctx 共享桥接状态（ledger/primarySession/client/issuedCommandAcks 等） */
export function createSessionMethods(ctx) {
	const pluginHandlers = createStepPluginHandlers();
	async function pluginReferenceCatalog(params) {
		if (!params.sessionId) return pluginHandlers["plugins/referenceCatalog"]();
		const session = ctx.primarySession?.sessionId === params.sessionId ? ctx.primarySession : ctx.readConversation(params.sessionId)?.session;
		if (!session) throw new BridgeError(-32002, "找不到该会话的插件目录");
		// Step 的可用目录由当前插件根拥有；旧会话快照会重新露出已移除项和过期开关。
		// 保留持久化历史，查询仅投影当前事实，不重启或干扰正在运行的轮次。
		const current = await pluginHandlers["plugins/referenceCatalog"]();
		return { authority: "session", plugins: current.plugins };
	}

	return {
		...pluginHandlers,
		"provider/testModelConnectivity": async params => {
			try { return await testProviderConnectivity(ctx, params); }
			catch (error) { throw new BridgeError(-32000, classifyStepSendError(error, params?.selection)); }
		},
		"plugins/referenceCatalog": pluginReferenceCatalog,
		"plugins/referenceCatalogWithCategory": pluginReferenceCatalog,
		"v4/usage/stats": async (params) => {
			const root = process.env.STEPCODE_USAGE_SESSION_DIR || join(process.env.STEP_CODING_AGENT_DIR || join(homedir(), ".stepcode", "agent"), "sessions");
			const workspaces = [...Object.keys(ctx.readPersistedWorkspaces()), join(process.env.ZCODE_DATA_BASE_DIR || join(homedir(), ".stepcode-desktop", "data"), ".zcode", "workspace", "default")];
			return buildUsageSnapshot(await readUsageSessions(root, workspaces), params);
		},
	 "provider/updateAccountConfig": (params) => {
			const revision = String(params?.revision ?? "").trim() || "0";
			return {
				receivedRevision: revision,
				providerCount: Object.keys(params?.providers ?? {}).length,
				status: "received",
			};
		},

		// Host 把 workspace/updateInteractionPreferences 放进 interactionPreferencesReady：该请求
		// -32601 会让 entry 的 ready promise 永久 reject，之后同 workspace 上的所有 RPC
		// （readPresentation / v4/command 发送消息）全部连锁失败。必须回合法 result 而不是 32601。
		"workspace/updateInteractionPreferences": (params) => ({
			workspace: params?.workspace,
			askUserQuestionAutoResolutionEnabled:
				params?.preferences?.askUserQuestionAutoResolutionEnabled === true,
			snoozedInteractionCount: 0,
		}),

		// 同一条 ready 链上的 model-io 偏好（新 Host 兼容旧 CLI 时对 -32601 有降级，但既然进了
		// 交互偏好链就一并实现，保持链路零异常）。
		"workspace/updateModelIoPreferences": (params) => ({
			workspace: params?.workspace,
			fullRetentionEnabled: params?.preferences?.fullRetentionEnabled === true,
			updatedSessionCount: 0,
		}),

		// 会话/工作区只读展示面（默认 build 档 + 无 slash 命令；Step CLI 的命令面经 host 侧
		// workspace-config topic 呈现，这里保持最小合法 presentation）。
		"workspace/readPresentation": (params) => ({
			workspace: params?.workspace,
			mode: "build",
			slashCommands: workflowSlashCommands,
		}),

		// v4 命令幂等查询（host 发消息前后 query ack 状态；未记录的命令幂等键回 unknown）。
		"v4/commands/query": (params) => ({
			results: (params?.commands ?? []).map((key) => ({
				key,
				result: ctx.issuedCommandAcks.get(`${key.sessionId ?? "null"}#${key.commandId}`) ?? "unknown",
			})),
		}),

		"session/create": async (params) => {
			if (ctx.turnBusy) throw new BridgeError(-32000, "当前对话正在运行，请完成后再新建会话");
			const sessionId = typeof params?.sessionId === "string" && params.sessionId ? params.sessionId : nextId("step-session");
			const workspace = await resolveSessionWorkspace(ctx, { workspace: params?.workspace });
			return ctx.runWithPreparedClient({ selection: null, requireIdle: true, reset: true, sessionId, workspace }, async client => {
			await client.newSession();
			// P0-04：firstInput/config 显式携带的模型选择失败必须如实报错（显式配置动作
			// 不吞错——ACK 不得在模型未生效时谎报建会话成功）；无显式选择时的默认兜底
			// 保持启动韧性（best-effort 继续，get_state 回读修正为实际生效值）。
			const explicitModel = sanitizeModelSelection(params?.model);
			const modelSelection = explicitModel ?? defaultModelSelection();
			try {
				await client.setModel(modelSelection.providerId, modelSelection.modelId);
			} catch (error) {
				if (explicitModel) {
					// 状态补救（评审高严重度失步）：此刻底座进程已被 stop+newSession 换成
					// 全新空会话，而桥接状态（primarySession/rows/ledger）仍指向旧会话——
					// 若不动，旧会话续发会因 sessionId 匹配跳过 restoreSession，静默打进
					// 无任何历史的空底座（回答无视全部上下文，无错误信号）。处置：先落盘
					// 保住内存行，再置空桥接会话状态——旧会话续发将走 restoreSession 从
					// 磁盘完整恢复（switch_session + 模型重放）；legacy session/send 则
					// requireSession 如实 -32002。都优于静默失步。
					if (ctx.primarySession) {
						ctx.persistConversation();
						ctx.primarySession = null;
						ctx.conversationRows = [];
						ctx.streamProjection = null;
						ctx.ledger.reset();
					}
					throw new BridgeError(-32000, classifyStepSendError(error, modelSelection));
				}
				log(`setModel failed (continuing with step default): ${error?.message ?? error}`);
			}
			ctx.primarySession = {
				sessionId,
				workspace,
				modelSelection,
				createdAt: Date.now(),
	            mode: acceptedPermissionMode(params?.mode),
				toolDenylist: params?.toolDenylist,
				toolAllowlist: params?.toolAllowlist,
			};
			{
				// P0-01：用底座实际生效模型修正 modelSelection——setModel best-effort 失败时
				// 快照不谎报请求值为已生效值（get_state().model 是唯一权威）。
				const rpcState = await ctx.client.getState();
				ctx.primarySession.stepSessionFile = rpcState.sessionFile;
				if (typeof rpcState.model?.provider === "string" && typeof rpcState.model?.id === "string") {
					ctx.primarySession.modelSelection = { providerId: rpcState.model.provider, modelId: rpcState.model.id,
						...(rpcState.model.provider === modelSelection.providerId && rpcState.model.id === modelSelection.modelId && modelSelection.options ? { options: modelSelection.options } : {}) };
				}
				// 实际生效思考档位（get_state.thinkingLevel）与可用档位面：档位是可切配置，
				// 读取失败（老底座无该字段）保持缺省——settings.thoughtLevel.enabled 如实 false。
				if (typeof rpcState.thinkingLevel === "string" && rpcState.thinkingLevel) {
					ctx.primarySession.thoughtLevel = rpcState.thinkingLevel;
				}
				ctx.primarySession.thoughtLevels = await ctx.client.getAvailableThinkingLevels().catch((error) => {
					log(`get_available_thinking_levels 失败（档位面保持禁用）: ${error?.message ?? error}`);
					return [];
				});
			}
			ctx.primarySession.pluginCatalog = (await pluginHandlers["plugins/referenceCatalog"]()).plugins;
			ctx.conversationRows = [];
			ctx.streamProjection = null;
			ctx.conversationSeq = 0;
			ctx.stateRevision += 1;
			// 台账生命周期：新会话整体清零（spec §4）。
			ctx.ledger.reset();
			log(`session/create sessionId=${sessionId} workspace=${ctx.primarySession.workspace.workspacePath}`);
			// 先落盘再广播：持有 sessions-index 订阅的可能是另一个桥接进程（读文件合并），
			// 也可能是本进程（下面的 upsert 立即送达）。落盘同时是重启后的唯一记忆。
			ctx.persistPrimarySummary();
			// 会话已存在而订阅早于它建立（host syncer 在 agent 就绪时即订阅 sessions-index，
			// 快照当时是空基线）：这里补发 session.upserted delta，让 syncer 把本会话写进
			// tasks-index 并广播 workspace_task_list_changed，侧栏「任务」列表立即出现本会话。
			// 用 setImmediate 保证 createSession 的响应行先于广播帧出线（post-response 惯例）。
			setImmediate(() => ctx.broadcastSessionsIndexUpsert());
			return makeSessionStateSnapshot({
				sessionId,
				workspace: ctx.primarySession.workspace,
	            mode: ctx.primarySession.mode,
				modelSelection: ctx.primarySession.modelSelection,
			});
			});
		},

		"session/resume": async (params) => {
			// HostCronRun 的绑定任务通过 task adapter 调用原 resume 协议；缺失入口会在重启后必然失败。
			if (ctx.turnBusy) throw new BridgeError(-32000, "当前对话仍在运行，不能恢复会话");
			if (typeof params?.sessionId !== "string" || !params.sessionId.trim())
				throw new BridgeError(-32602, "恢复会话缺少 sessionId");
			if (params.workspace) await resolveSessionWorkspace(ctx, { workspace: params.workspace });
			await ctx.restoreSession(params.sessionId);
			if (params.thoughtLevel) await ctx.applyThoughtLevel(params.thoughtLevel);
			const session = ctx.requireSession();
			if (params.toolDenylist !== undefined) session.toolDenylist = [...params.toolDenylist];
			if (params.toolAllowlist !== undefined) session.toolAllowlist = [...params.toolAllowlist];
			ctx.persistConversation();
			const snapshot = makeSessionStateSnapshot({ ...session, thoughtLevels: {
				available: session.thoughtLevels ?? [], current: session.thoughtLevel,
			} });
			// 快照工厂默认新建时间；resume 必须保留历史创建时间，避免 task index 在恢复时变成新任务。
			if (Number.isFinite(session.createdAt)) snapshot.session.createdAt = session.createdAt;
			return snapshot;
		},
		"session/subscribe": (params) => {
			const session = ctx.requireSession();
			return { sessionId: params?.sessionId ?? session.sessionId, eventSeq: ctx.eventSeq, events: [] };
		},

		"session/send": async (params) => {
			const session = ctx.requireSession();
			session.mode = acceptedPermissionMode(params?.mode, session.mode);
			const text = typeof params?.content === "string" ? params.content : "";
			const attachments = params?.attachments ?? [];
			if (!hasPromptInput({ text, attachments })) throw new BridgeError(-32000, "输入为空（无文字且无附件），已拒绝");
			// P0-02：legacy 路径同走统一 admission（busy 从一律 steer 改为按裁决三分流）。
			await ctx.admitAndSend({
				commandId: nextId("legacy-send"),
				text,
				attachments,
				mode: session.mode,
				modelSelection: session.modelSelection,
				automationId: params?.automationId,
				toolDisallowlist: params?.toolDenylist,
				botDeliveryTarget: params?.botDeliveryTarget,
			});
			ctx.stateRevision += 1;
			return { sessionId: session.sessionId, accepted: true, stateRevision: ctx.stateRevision };
		},

		"session/setModel": async (params) => {
			const session = ctx.requireSession();
			const selection = params?.model ?? {
				providerId: params?.providerId ?? "step",
				modelId: params?.modelId ?? defaultModelSelection().modelId,
			};
			await ctx.applyModelSelection(selection);
			return makeSessionStateSnapshot({
				sessionId: session.sessionId,
				workspace: session.workspace,
	            mode: session.mode,
				modelSelection: session.modelSelection,
			});
		},

		"session/setThoughtLevel": async (params) => {
			const session = ctx.requireSession();
			await ctx.applyThoughtLevel(params?.thoughtLevel);
			if (typeof params?.thoughtLevel === "string" && params.thoughtLevel) ctx.broadcastConversationSnapshot();
			return makeSessionStateSnapshot({
				sessionId: session.sessionId,
				workspace: session.workspace,
				mode: session.mode,
				modelSelection: session.modelSelection,
				thoughtLevels: { available: session.thoughtLevels ?? [], current: session.thoughtLevel },
			});
		},

		"session/read": (params) => {
			const session = ctx.primarySession?.sessionId === params.sessionId ? ctx.primarySession : ctx.readConversation(params.sessionId)?.session;
			if (!session) throw new BridgeError(-32002, "找不到该会话的本地记录");
			const rows = ctx.primarySession?.sessionId === params.sessionId ? ctx.conversationRows : ctx.readConversation(params.sessionId)?.rows;
			const firstText = rows?.find(r=>r.kind==="userInput")?.text;
			// P1-01 防覆盖守卫（读侧）：custom 标题直接原样返回，不按首条用户消息重新派生——
			// 否则改名后宿主侧 session/read 会把派生标题当权威值盖回 UI。titleSource 不进
			// snapshot（v4 wire meta 接入是后续轮的空挂设计，这里只在桥内持久化层生效）。
			const customTitle = session.titleSource === "custom" && typeof session.title === "string" && session.title ? session.title : null;
	        return makeSessionStateSnapshot({...session,title:customTitle ?? (firstText ? Array.from(firstText).slice(0,30).join("") : session.title),thoughtLevels:{available:session.thoughtLevels??[],current:session.thoughtLevel}});
		},
		// 真实会话列表：读 sessions-index 持久化摘要 + 逐会话文件补充 mode/model。
		// session/messages、session/events 不再注册——宿主全仓无调用方，历史事件也不
		// 落盘，返回空数组会掩盖"未实现"；未注册走 -32601 让 host 按可选能力降级。
		"session/list": (params) => {
			const workspacePath = typeof params?.workspace?.workspacePath === "string" && params.workspace.workspacePath
				? params.workspace.workspacePath
				: process.cwd();
			const workspaceKey = typeof params?.workspace?.workspaceKey === "string" && params.workspace.workspaceKey
				? params.workspace.workspaceKey
				: ctx.normalizeWorkspaceKey(workspacePath);
			const requestedIds = Array.isArray(params?.sessionIds)
				? new Set(params.sessionIds.filter((id) => typeof id === "string" && id))
				: null;
			const limit = Number.isFinite(params?.limit) && params.limit > 0 ? params.limit : 200;
			const phaseOf = (summary) => {
				if (ctx.primarySession?.sessionId === summary.sessionId) {
					return ctx.turnBusy ? "running" : ctx.conversationRows.length ? "completedSuccess" : "draft";
				}
				return summary.phase;
			};
			const sessions = ctx.persistedSummariesFor(params?.workspace?.workspaceIdentity || params?.workspace?.workspaceKey || workspacePath,
				Boolean(params?.workspace?.workspaceIdentity) || Boolean(params?.workspace?.workspaceKey && params.workspace.workspaceKey !== workspacePath))
				.filter((summary) => !requestedIds || requestedIds.has(summary.sessionId))
				.map((summary) => {
					const saved = ctx.primarySession?.sessionId === summary.sessionId
						? null
						: ctx.readConversation(summary.sessionId);
					const session = ctx.primarySession?.sessionId === summary.sessionId ? ctx.primarySession : saved?.session;
					const phase = phaseOf(summary);
					return {
						sessionId: summary.sessionId,
						workspace: { workspacePath, workspaceKey },
						sessionKind: "interactive",
						title: summary.title ?? `${COMMUNITY_BACKEND_LABEL} session`,
						mode: acceptedPermissionMode(session?.mode),
						status: phase === "running" ? "running" : phase === "error" ? "error" : phase === "draft" ? "idle" : "completed",
						...(session?.modelSelection ? { model: session.modelSelection } : {}),
						createdAt: Number(summary.createdAt) || Date.now(),
						updatedAt: Number(summary.lastActivityAt) || Date.now(),
					};
				})
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, limit);
			return { sessions };
		},

		"session/stop": async () => {
			if (ctx.streamProjection) ctx.streamProjection.outcome = "completedInterrupted";
			// stop 冻结台账：保留队列项展示（autoDrain=false+pauseReason=stopped）且不再
			// reconcile（spec §4/§6），再让底座 abort 清池停轮。
			await ctx.stopCurrentTurn();
			return { stopped: true };
		},

		/**
		 * MCP 状态（mcpSyncService 轮询消费）：桥接不启动宿主配置的 MCP server——
		 * 对每个请求的 server 如实报告 disconnected + runtime_unavailable，不用空
		 * statuses 冒充"全部正常/没有 server"。桥接自管的 Step 插件（plugins/*）不经
		 * 此面报告运行态（真实状态在 Step 子进程内，桥接不可见，不伪造 connected）。
		 */
		"mcp/list": async (params) => {
			const statuses = await readPluginRuntimeStatuses(process.env.STEPCODE_STORAGE_ROOT_DIR || ctx.STATE_DIR);
			for (const server of Array.isArray(params?.mcpServers) ? params.mcpServers : []) {
				if (!server || typeof server.name !== "string" || !server.name) continue;
				if(statuses[server.name])continue;
				statuses[server.name] = {
					status: "disconnected",
					transport: server.type === "http" || server.type === "sse" ? server.type : "stdio",
					toolCount: 0,
					updatedAt: new Date().toISOString(),
					failureKind: "runtime_unavailable",
					error: "Step Code 社区桥接未接入宿主 MCP 连接面，该 server 未被启动",
				};
			}
			return { statuses };
		},
	};
}
