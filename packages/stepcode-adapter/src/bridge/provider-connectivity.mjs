import { StepCodeRpcClient } from "../rpc-client.mjs";
import { readDesktopCredentialEnv } from "../credentials.mjs";
import { resolveStepRuntimePaths } from "../model-config-signatures.mjs";
import { hasMappedProviderOptions, prepareProviderRequestOptions } from "../provider-request-options.mjs";
import { resolveThoughtLevel } from "../thought-level-selection.mjs";
import { assertHostModelAdmission } from "./model-admission.mjs";

/** 探测是独立明确选择，只使用本次 SDK 启动快照，不能借用聊天选项或实时文件。 */
export function connectivityProbeOptions(model) {
	const values = model?.compat?.stepcodeDesktop?.optionSpecs?.reasoningLevel?.values;
	if (!Array.isArray(values) || !values.length) return undefined;
	const reasoningLevel = ["disabled", "off", "minimal", "low"].find(value => values.includes(value)) ?? values[0];
	return { reasoningLevel };
}

/** 设置页测试原先没有桥接实现；独立临时客户端避免改动正在使用的会话。 */
export async function testProviderConnectivity(ctx, params, createClient = options => new StepCodeRpcClient(options)) {
	const { providerId, modelId } = params?.selection ?? {};
	if (typeof providerId !== "string" || !providerId.trim() || typeof modelId !== "string" || !modelId.trim()) {
		throw new Error("模型测试需要有效的供应商与模型");
	}
	await assertHostModelAdmission(ctx, { sessionId: ctx.primarySession?.sessionId ?? "provider-connectivity" });
	const source = ctx.options.stepEnv ?? process.env;
	const env = ctx.clientEnvironment ? await ctx.clientEnvironment() : { ...source, ...readDesktopCredentialEnv(source), STEP_CODING_AGENT_DIR: (await resolveStepRuntimePaths(source)).agentDir };
	const client = createClient({
		command: [...ctx.spawnCommand, "--no-session", "--no-tools", "--no-extensions"],
		communicationMode: ctx.options.communicationMode ?? "required",
		cwd: ctx.options.stepCwd ?? process.cwd(),
		env,
		requestTimeoutMs: 60_000,
	});
	let timer;
	let unsubscribe;
	let unsubscribeFailure;
	try {
		await client.start();
		await client.setModel(providerId, modelId);
		await assertHostModelAdmission(ctx, { sessionId: ctx.primarySession?.sessionId ?? "provider-connectivity", selection: { providerId, modelId } });
		const probeState = await client.getState?.();
		let probeOptions = connectivityProbeOptions(probeState?.model);
		if (!probeOptions && client.getAvailableModels) probeOptions = connectivityProbeOptions((await client.getAvailableModels()).find(model => model.provider === providerId && model.id === modelId));
		if (!probeOptions) probeOptions = (await hasMappedProviderOptions(client, { providerId, modelId })).probeOptions;
		const policy = await prepareProviderRequestOptions(client, { providerId, modelId, options: probeOptions });
		if (probeOptions?.reasoningLevel && !policy.reasoningMapped) {
			const levels = await client.getAvailableThinkingLevels();
			const level = resolveThoughtLevel(probeOptions.reasoningLevel, levels, probeState?.thinkingLevel);
			if (level) await client.setThinkingLevel(level);
		}
		// 立即安装拒绝处理器；prompt admission 失败时不能遗留未处理的等待拒绝。
		const events = [];
		const completion = new Promise((resolve, reject) => {
			timer = setTimeout(() => reject(new Error("模型测试超时")), 60_000);
			unsubscribe = client.onEvent(event => {
				events.push(event);
				if (event.type === "agent_settled") resolve(events);
			});
			unsubscribeFailure = client.onFailure?.(reject);
		});
		completion.catch(() => {});
		await client.prompt("Reply with OK only. Do not use tools.");
		await completion;
		if (events.some(event => event.type === "message_end" && event.message?.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted"))) {
			throw new Error("底层模型测试未正常完成");
		}
		const state = await client.getState();
		if (state.model?.provider !== providerId || state.model?.id !== modelId) throw new Error("底层模型选择与测试目标不一致");
		const reply = await client.getLastAssistantText();
		if (typeof reply !== "string" || !reply.trim()) throw new Error("模型测试没有返回有效回复");
		return { success: true };
	} finally {
		clearTimeout(timer);
		unsubscribe?.();
		unsubscribeFailure?.();
		await client.stop();
	}
}
