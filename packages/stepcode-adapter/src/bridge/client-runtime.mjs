/*
 * 底座运行时装配（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）：
 * 工作流桥、保存工作流目录访问、宿主反向请求（内置浏览器）、StepCodeRpcClient
 * 的启动/重启。Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import { writeFileSync, renameSync } from "node:fs";
import process from "node:process";
import { join } from "node:path";
import { createWorkflowBridge, installWorkflowPlugin } from "../workflow/bridge.mjs";
import { delegatesWorkflowApproval } from "../workflow/catalog.mjs";
import { startEmbeddedBrowserRelay } from "../embedded-browser-relay.mjs";
import { readDesktopCredentialEnv } from "../credentials.mjs";
import { stepPermissionStatusWarning } from "../permission-policy.mjs";
import { StepCodeRpcClient } from "../rpc-client.mjs";
import { nextId } from "../wire-shapes.mjs";
import { readModelConfigSignatures, modelEnvironmentSignature, resolveStepRuntimePaths } from "../model-config-signatures.mjs";
import { ensureOfficialStepPlugins, syncOfficialNodeHost, pluginConfigSignature, readPluginConfigSnapshot, resolveStartedPluginSignature } from "../official-plugins.mjs";
import { hasMappedProviderOptions, prepareProviderRequestOptions, carryProviderRequestOptions, discardProviderRequestOptions } from "../provider-request-options.mjs";
import { resolveThoughtLevel } from "../thought-level-selection.mjs";
import { assertHostModelAdmission } from "./model-admission.mjs";
import { extensionConfigSignature } from "../extension-config-signature.mjs";
import { desktopAutomationEnvironment } from "../desktop-automation.mjs";
import { log } from "./logging.mjs";

/** @param {any} ctx 共享桥接状态（options/spawnCommand/primarySession/projectStepEvent 等） */
export function createClientRuntime(ctx) {
	let clientOperations = Promise.resolve();
	const removedConfiguredModels = new Set();
	const runtimeEnvironment = () => ctx.options.stepEnv ?? process.env;
	function runClientOperation(operation) {
		const result = clientOperations.then(operation);
		// 模型删除/选择失败可由下一次有效选择恢复；只有历史恢复失败保留关闭保护。
		clientOperations = result.catch(() => {});
		return result;
	}
	async function clientEnvironment() {
		const source = runtimeEnvironment();
		const env = { ...source, ...readDesktopCredentialEnv(source) };
		// 工作流 actor 同属 app 装配，却没有主进程 PID relay；只能禁原生调度，不能假装拥有桌面工具端口。
		if (env.STEP_BACKEND === "stepcode-local") env.STEP_DISABLE_CRON = "1";
		return { ...env, STEP_CODING_AGENT_DIR: (await resolveStepRuntimePaths(env)).agentDir };
	}
	async function preparePrompt(client, selection, requestId) {
		await assertHostModelAdmission(ctx, { selection });
		// Host barrier 可跨过另一次发布；还没发 HTTP 时配置漂移必须拒绝，不能偷用旧快照。
		const env = await clientEnvironment(), signatures = await readModelConfigSignatures(ctx.options.stepModelsFile, env);
		const key = `${selection.providerId}\0${selection.modelId}`;
		if (ctx.modelConfigSignatures?.get(key) !== signatures.get(key) || modelEnvironmentSignature(env) !== ctx.modelEnvironmentSignature)
			throw Object.assign(new Error("模型配置在准备期间发生变化，请再次发送或继续队列"), { code: "model_configuration_changed" });
		try { return await prepareProviderRequestOptions(client, { ...selection, requestId }); }
		catch (error) {
			if (error.providerOptionsUncertain) { ctx.clientStartPromise = Promise.reject(error); ctx.clientStartPromise.catch(() => {}); }
			throw error;
		}
	}
	async function carryPrompt(client, selection, requestId) {
		try { return await carryProviderRequestOptions(client, { ...selection, requestId }); }
		catch (error) {
			if (error.providerOptionsUncertain) { ctx.clientStartPromise = Promise.reject(error); ctx.clientStartPromise.catch(() => {}); }
			throw error;
		}
	}
	async function discardPreparedPrompt(client, selection, requestId) {
		try { await discardProviderRequestOptions(client, { ...selection, requestId }); }
		catch (error) {
			// 无法确认纯 transport 准备已清理，关闭后续投递；不能让旧选项污染下一轮。
			ctx.clientStartPromise = Promise.reject(error); ctx.clientStartPromise.catch(() => {});
			throw error;
		}
	}
	function notifyWorkflowCompletion(id, result, origin = {}) {
		log(`workflow ${result.runId} ${result.status}`);
		if (ctx.shuttingDown || ctx.primarySession?.sessionId !== id || !ctx.client?.isRunning()) return Promise.resolve();
		// 原生 followUp 在 agent_end 后直接续跑，无法先准备 transport；复用现有台账。
		return ctx.runInputOperation(async () => {
			if (ctx.shuttingDown || ctx.primarySession?.sessionId !== id) return;
			return ctx.admitAndSend({ commandId: nextId("workflow-notice"), kind: "sendText", clientId: "stepcode-workflow",
				text: `工作流状态通知：${JSON.stringify(result)}`, modelSelection: ctx.primarySession.modelSelection,
				automationId: origin?.automationId, toolDisallowlist: origin?.toolDisallowlist, botDeliveryTarget: origin?.botDeliveryTarget,
				requestedDelivery: "queue", followupMode: "queue" });
		});
	}
	const workflowBridge = createWorkflowBridge({
		// P0-05：工作流 actor 走独立底座命令（--approval-mode auto，后台无人值守不回归）；
		// 未装配 actorSpawnCommand 的调用方回退主会话命令（confirm 档，fail-closed 方向）。
		root: ctx.STATE_DIR, command: ctx.actorSpawnCommand ?? ctx.spawnCommand, turnId: () => ctx.currentTurnId,
		communicationMode: ctx.options.communicationMode ?? "required",
		prepareModelExecution: (id, selection) => assertHostModelAdmission(ctx, { sessionId: id, selection }), getClientEnvironment: clientEnvironment,
		session: id => ctx.primarySession?.sessionId === id ? ctx.primarySession : ctx.readConversation(id)?.session,
		rows: id => ctx.primarySession?.sessionId === id ? ctx.conversationRows : (ctx.readConversation(id)?.rows ?? []),
		changed: id => {
			ctx.broadcastConversationSnapshot(`conversation/${id}`);
			// 等待的进入/退出与后台工作变化必须同时到达列表事实源，不能只更新会话正文。
			if (ctx.primarySession?.sessionId === id) {
				ctx.persistPrimarySummary();
				ctx.broadcastSessionsIndexUpsert();
			}
		},
		completed: (id, result, origin) => { void notifyWorkflowCompletion(id, result, origin).catch(error => log(error.message)); },
	});
	ctx.workflowBridge = workflowBridge;

	async function savedCatalog(params) {
		const { createSavedWorkflowCatalog } = await import("../workflow/saved.mjs");
		return createSavedWorkflowCatalog(params.workspace?.workspacePath || ctx.options.stepCwd || process.cwd(), ctx.STATE_DIR);
	}
	function finishWorkflowTool(sessionId, toolCallId, result) {
		const saved = ctx.primarySession?.sessionId === sessionId ? null : ctx.readConversation(sessionId);
		const rows = saved?.rows ?? ctx.conversationRows;
		const row = rows.find(row => row.toolCallId === toolCallId);
		if (row) { row.status = result.ok ? "success" : "cancelled"; row.output = {text:JSON.stringify(result)}; }
		if (saved) { const file = ctx.conversationFile(sessionId), temp = file + "." + process.pid + ".tmp"; writeFileSync(temp,JSON.stringify(saved));renameSync(temp,file); }
		ctx.broadcastConversationSnapshot(`conversation/${sessionId}`);
	}

	let embeddedBrowserRelayPromise = null;
	function requestHost(method, params) {
		const id = nextId("browser-host");
		return new Promise((resolve, reject) => {
			if (!ctx.pendingHostRequests || typeof ctx.writeFrame !== "function") { reject(new Error("Host 反向请求通道不可用")); return; }
			const label = method.startsWith("automation/") ? "桌面定时任务" : method === "interaction/prepareModelExecution" ? "模型执行准入" : "内置浏览器";
			const timer = setTimeout(() => { ctx.pendingHostRequests.delete(id); reject(new Error(`${label}请求超时`)); }, 90000);
			ctx.pendingHostRequests.set(id, { resolve, reject, timer });
			try { ctx.writeFrame({ id, method, params: method.startsWith("automation/") || method === "interaction/prepareModelExecution" ? params : { ...params, requestId: id } }); }
			catch (error) { clearTimeout(timer); ctx.pendingHostRequests.delete(id); reject(error); }
		});
	}
	async function ensureBrowserRelay() {
		if (!runtimeEnvironment().STEPCODE_STORAGE_ROOT_DIR) return null;
		ctx.pluginStatuses??=new Map();
		if (!embeddedBrowserRelayPromise) embeddedBrowserRelayPromise = startEmbeddedBrowserRelay({
			directory: join(runtimeEnvironment().STEPCODE_STORAGE_ROOT_DIR, "browser-bridges"), requestHost,
			pluginStatuses:ctx.pluginStatuses,
			workflowRequest: (command, context) => workflowBridge.request(command, context),
			getContext: (pid) => ctx.client?.child?.pid === pid ? {
				...(ctx.primarySession?{sessionId: ctx.primarySession.sessionId}:{}),
				...(ctx.currentTurnId ? { turnId: ctx.currentTurnId } : {}),
				workspaceKey: ctx.primarySession?.workspace.workspaceKey || ctx.primarySession?.workspace.workspacePath || ctx.options.stepCwd || process.cwd(),
				workspacePath: ctx.primarySession?.workspace.workspacePath || ctx.options.stepCwd || process.cwd(),
				clientMode: "desktop-continuous", sessionContext: "live",
				desktopTaskMode: ctx.client?.options.env?.STEPCODE_TASK_MODE === "desktop",
				activeTurn: ctx.turnBusy === true,
				modelSelection: ctx.primarySession?.modelSelection,
				mode: ctx.primarySession?.mode,
				activeAutomationId: ctx.activeAutomationId,
				toolDisallowlist: [...new Set([...(ctx.primarySession?.toolDenylist ?? []), ...(ctx.activeToolDisallowlist ?? [])])],
				toolAllowlist: ctx.primarySession?.toolAllowlist,
				botDeliveryTarget: ctx.activeBotDeliveryTarget,
			} : null,
		}).then(relay => { ctx.embeddedBrowserRelay = relay; return relay; });
		return embeddedBrowserRelayPromise;
	}
	async function startClient(env) {
		env ??= await clientEnvironment();
		if (env.STEP_BACKEND === "stepcode-local") {
			if (!env.STEPCODE_STORAGE_ROOT_DIR) throw new Error("Desktop automation storage root is unavailable");
			env = desktopAutomationEnvironment(env);
		}
		await installWorkflowPlugin(env.STEPCODE_STORAGE_ROOT_DIR);
		if(env.STEP_BACKEND==="stepcode-local"&&env.STEPCODE_STORAGE_ROOT_DIR){await ensureOfficialStepPlugins(env.STEPCODE_STORAGE_ROOT_DIR);await syncOfficialNodeHost(env.STEPCODE_STORAGE_ROOT_DIR);}
		const relay = await ensureBrowserRelay();
		if (!ctx.client) {
			ctx.client = new StepCodeRpcClient({
				command: ctx.spawnCommand,
				onSpawn: relay ? pid => relay.bindPid(pid) : undefined,
				communicationMode: ctx.options.communicationMode ?? "required",
				env,
				cwd: ctx.options.stepCwd ?? process.cwd(),
				// UI 批准策略：默认 fail-closed（client 无 handler 时自动回 {cancelled:true}，
				// 对齐 Step-Code 无 UI 时的默认拒绝）；--auto-approve 1 显式自动放行，
				// 仅建议驱动 mock（无真实副作用）时使用。MVP 未做
				// interaction/requestPermission 反向请求桥接。
				onUiRequest: ctx.options.autoApprove
					? async (request) => {
							log(`auto-approving UI request ${request?.method} (${request?.title ?? ""})`);
							return { confirmed: true };
						}
					: async request => delegatesWorkflowApproval(request) ? {confirmed:true} : ctx.primarySession ? workflowBridge.permission(ctx.primarySession.sessionId, request) : {cancelled:true},
				onStderrLine: (line) => log(`step stderr: ${line}`),
			});
			const ownedClient = ctx.client;
			let activeTurnId = null;
			ownedClient.onEvent(event => {
				if (ctx.client !== ownedClient) return;
				ctx.projectStepEvent(event);
				if (event.type === "agent_start") activeTurnId = ctx.currentTurnId;
				if (event.type === "agent_settled") activeTurnId = null;
			});
			ownedClient.onFailure(error => {
				if (ctx.client === ownedClient && ctx.turnBusy) ctx.projectStepEvent({ type: "step_client_failed", turnId: activeTurnId, errorMessage: error.message });
			});
			// P0-05：setStatus(step-permission) 档位回执探针（判定逻辑是可注入纯函数
			// stepPermissionStatusWarning，单测见 suites/permission-drafts.mjs）：主会话底座
			// 期望 'Mode: Ask'，回执非 Ask 即 log 告警——把「旧版底座对 argv 不识别、
			// 静默退回 bypass」从隐患变成日志可检测，兼作真机验收断言探针。缺帧容忍
			//（mock/旧版不发该帧不告警）。只挂主会话 client：actor 底座 auto 是设计值。
			ctx.client.onEvent((event) => {
				const warning = stepPermissionStatusWarning(event);
				if (warning) log(warning);
			});
		}
		const signatures = await readModelConfigSignatures(ctx.options.stepModelsFile, env);
		for (const key of ctx.modelConfigSignatures?.keys() ?? []) if (!signatures.has(key)) removedConfiguredModels.add(key);
		for (const key of signatures.keys()) removedConfiguredModels.delete(key);
		ctx.modelConfigSignatures = signatures;
		ctx.modelEnvironmentSignature = modelEnvironmentSignature(env);
		const pluginRoot = env.STEPCODE_STORAGE_ROOT_DIR || ctx.STATE_DIR;
		const pluginsBeforeStart = await readPluginConfigSnapshot(pluginRoot);
		ctx.pluginSignature = pluginsBeforeStart.signature;
		ctx.extensionSignature = await extensionConfigSignature(env, ctx.options.stepCwd ?? process.cwd());
		await ctx.client.start();
		// SDK 自动供应插件属于本次已加载内容；已有配置的并发修改仍要求下一步刷新。
		ctx.pluginSignature = resolveStartedPluginSignature(pluginsBeforeStart, await readPluginConfigSnapshot(pluginRoot));
	}

	function refreshBlocked() {
		return ctx.turnBusy || (ctx.primarySession && workflowBridge.snapshot(ctx.primarySession.sessionId).pendingInteractions.length > 0);
	}

	async function restartClient(state, env) {
		await ctx.client.stop();
		ctx.client = null;
		await startClient(env);
		if (state.sessionFile) {
			const restored = await ctx.client.request({ type: "switch_session", sessionPath: state.sessionFile });
			if (!restored.success || restored.data?.cancelled) throw new Error("刷新模型后恢复会话失败");
		}
		if (state.sessionName) {
			const renamed = await ctx.client.request({ type: "set_session_name", name: state.sessionName });
			if (!renamed.success) throw new Error("刷新模型后恢复会话标题失败");
		}
	}

	async function ensureStarted() {
		if (!ctx.clientStartPromise) {
			ctx.clientStartPromise = startClient().catch(async error => {
				// 初次启动失败没有已恢复历史，丢弃半成品，下一次读取修正后的真实 env/config。
				await ctx.client?.stop().catch(() => {});
				ctx.client = null; ctx.clientStartPromise = null;
				throw error;
			});
		}
		await ctx.clientStartPromise;
	}

	async function prepareClient({ selection = ctx.primarySession?.modelSelection, requireIdle = false, selectModel = false, refreshAll = false, reset = false, sessionId, workspace } = {}) {
		if (reset || !ctx.clientStartPromise) await assertHostModelAdmission(ctx, { sessionId, workspace });
		if (reset) {
			if (refreshBlocked() || (ctx.client && ctx.client.isRunning?.() !== false && (await ctx.client.getState()).isStreaming)) throw new Error("当前对话仍在运行，不能新建会话");
			await ctx.client?.stop(); ctx.client = null; ctx.clientStartPromise = null;
		}
		await ensureStarted();
		if (refreshBlocked()) {
			if (requireIdle) throw new Error("当前对话仍在运行，不能修改模型连接或思考档位");
			return ctx.client;
		}
		const state = await ctx.client.getState();
		if (refreshBlocked() || state.isStreaming) {
			if (requireIdle) throw new Error("当前对话仍在运行，不能修改模型连接或思考档位");
			return ctx.client;
		}
		await assertHostModelAdmission(ctx, { sessionId, workspace });
		const env = await clientEnvironment();
		const signatures = await readModelConfigSignatures(ctx.options.stepModelsFile, env);
		const signatureKey = selection ? `${selection.providerId}\0${selection.modelId}` : undefined;
		if (signatureKey && (ctx.modelConfigSignatures?.has(signatureKey) || removedConfiguredModels.has(signatureKey)) && !signatures.has(signatureKey)) {
			throw new Error(`Model not found: ${selection.providerId}/${selection.modelId}（模型配置已删除）`);
		}
		const pluginSignature = ctx.pluginSignature === undefined ? undefined : await pluginConfigSignature(env.STEPCODE_STORAGE_ROOT_DIR || ctx.STATE_DIR);
		const extensions = ctx.extensionSignature === undefined ? undefined : await extensionConfigSignature(env, ctx.options.stepCwd ?? process.cwd());
		const models = selection ? await ctx.client.getAvailableModels() : [];
		const hasModel = () => models.some(model => model.provider === selection.providerId && model.id === selection.modelId);
		const changed = signatureKey && ctx.modelConfigSignatures && signatures.get(signatureKey) !== ctx.modelConfigSignatures.get(signatureKey);
		const allChanged = refreshAll && ctx.modelConfigSignatures && (signatures.size !== ctx.modelConfigSignatures.size || [...signatures].some(([key, value]) => ctx.modelConfigSignatures.get(key) !== value));
		const envChanged = ctx.modelEnvironmentSignature !== undefined && modelEnvironmentSignature(env) !== ctx.modelEnvironmentSignature;
		const restart = changed || allChanged || envChanged || pluginSignature !== ctx.pluginSignature || extensions !== ctx.extensionSignature || (selection && !hasModel());
		// 配置/目录 IO 期间原生轮次或交互可能进入忙态；写进程前再次读取权威状态。
		if (refreshBlocked() || ((restart || selectModel || requireIdle) && (await ctx.client.getState()).isStreaming)) {
			if (requireIdle) throw new Error("当前对话仍在运行，不能修改模型连接或思考档位");
			return ctx.client;
		}
		if (restart) {
			// 整个准备事务持锁，不能在 stop 与 set_model 之间让并发选择穿透。
			// 仅真正恢复失败保持 rejected 启动点；目标模型不可用则仍可显式选择其他模型。
			ctx.clientStartPromise = restartClient(state, env);
			await ctx.clientStartPromise;
			// 选择/档位不可用是可恢复错误，不得污染已经恢复历史的启动等待点。
			if (!selection && !refreshAll) {
				if (state.model?.provider && state.model?.id) await ctx.client.setModel(state.model.provider, state.model.id);
				if (state.thinkingLevel) await ctx.client.setThinkingLevel(state.thinkingLevel);
			}
		}
		if ((selectModel || restart) && selection) {
			await ctx.client.setModel(selection.providerId, selection.modelId);
			const requestedThinking = selection.options?.reasoningLevel;
			if (!requestedThinking && state.thinkingLevel && state.model?.provider === selection.providerId && state.model?.id === selection.modelId) await ctx.client.setThinkingLevel(state.thinkingLevel);
			if (requestedThinking) {
				const policy = await hasMappedProviderOptions(ctx.client, selection);
				// 有显式 map 的原始 UI 值由正式扩展映射，不能反猜为 SDK 档位覆盖它。
				if (!policy.reasoningMapped) {
					const levels = await ctx.client.getAvailableThinkingLevels();
					const thinking = resolveThoughtLevel(requestedThinking, levels, state.thinkingLevel);
					if (thinking) await ctx.client.setThinkingLevel(thinking);
				}
			}
			const selected = (await ctx.client.getState()).model;
			if (selected?.provider !== selection.providerId || selected?.id !== selection.modelId) throw new Error("底座模型选择与请求目标不一致");
		}
		return ctx.client;
	}

	function runWithPreparedClient(options, operation) {
		return runClientOperation(async () => operation(await prepareClient(options)));
	}
	function ensureClient() { return runWithPreparedClient({}, () => {}); }
	function setClientModel(providerId, modelId) {
		return runWithPreparedClient({ selection: { providerId, modelId }, requireIdle: true, selectModel: true }, async client => (await client.getState()).model);
	}

	return { workflowBridge, savedCatalog, finishWorkflowTool, requestHost, ensureBrowserRelay, ensureClient, setClientModel, runWithPreparedClient, runClientOperation, clientEnvironment, resolveThoughtLevel, preparePrompt, carryPrompt, discardPreparedPrompt, notifyWorkflowCompletion, assertModelAdmission: options => assertHostModelAdmission(ctx, options) };
}
