/**
 * StepCodeRpcClient 的原生 RPC 命令方法族（prompt/steer/follow_up/abort、会话与
 * 模型命令、条目/树/消息读取、bash）。自 rpc-client.mjs 机械拆出：方法体未改动，
 * 经 rpc-client.mjs 挂回 StepCodeRpcClient.prototype，公共接口不变。
 *
 * 本文件派生自 stepfun-ai/Step-Code（https://github.com/stepfun-ai/Step-Code，
 * packages/coding-agent/src/modes/rpc/rpc-client.ts），依其 MIT License 授权，
 * 原版权与许可声明随本文件保留：
 *
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2026 Step Code
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

/** @typedef {import("./rpc-protocol.mjs").RpcResponse} RpcResponse */
/** @typedef {import("./rpc-protocol.mjs").JsonAgentSessionEvent} JsonAgentSessionEvent */
/** @typedef {import("./rpc-protocol.mjs").RpcSessionState} RpcSessionState */

/**
 * 命令方法族（this 绑定 StepCodeRpcClient 实例）。
 * @type {Record<string, any>}
 */
export const rpcCommandMethods = {
	/**
	 * 发 prompt（preflight 成功即返回；事件经 onEvent 流出，用 waitForIdle/promptAndWait 等完成）。
	 * preflight 失败（如无凭据）时响应为 success:false，此处抛 stepRejected=true 的错误
	 * （显式拒绝：上层台账据此回滚并可清理空草稿）。
	 * @param {string} message
	 * @param {{ images?: Array<{type:"image", data:string, mimeType:string}>, streamingBehavior?: "steer"|"followUp", timeoutMs?: number }} [options]
	 */
	async prompt(message, options = {}) {
		const response = await this.request({
			type: "prompt",
			message,
			images: options.images,
			streamingBehavior: options.streamingBehavior,
		}, { timeoutMs: options.timeoutMs });
		if (!response.success) {
			throw Object.assign(new Error(response.error ?? "prompt failed"), { stepRejected: true });
		}
	},

	/**
	 * prompt 并收集事件直到 agent_settled。
	 * @param {string} message
	 * @param {{ images?: Array<{type:"image", data:string, mimeType:string}>, streamingBehavior?: "steer"|"followUp", timeoutMs?: number }} [options]
	 * @returns {Promise<JsonAgentSessionEvent[]>}
	 */
	async promptAndWait(message, options = {}) {
		const timeoutMs = options.timeoutMs ?? 60000;
		const controller = new AbortController();
		const eventsPromise = this.collectEvents(timeoutMs, { signal: controller.signal });
		// 预检可能先拒绝；等待必须有拒绝处理器，并在 finally 释放订阅和计时器。
		eventsPromise.catch(() => {});
		try {
			await this.prompt(message, options);
			return await eventsPromise;
		} finally { controller.abort(); }
	},

	/**
	 * 排队转向消息（中断当前轮改道）。
	 * 底座对 `/` 开头 extension command 会回 success:false 的显式拒绝（包成
	 * errorResponse 上线），handleLine 对任何带 id 的 response 帧一律 resolve——
	 * 必须补 success 检查，否则显式拒绝被吞成假成功。stepRejected=true 供台账回滚。
	 * @param {string} message
	 * @param {Array<{type:"image", data:string, mimeType:string}>} [images]
	 */
	async steer(message, images) {
		const response = await this.request({ type: "steer", message, images });
		if (!response.success) {
			throw Object.assign(new Error(response.error ?? "steer failed"), { stepRejected: true });
		}
	},

	/**
	 * 排队 follow-up（当前轮结束后处理）。同 steer：必须检查 success 防吞显式拒绝。
	 * @param {string} message
	 * @param {Array<{type:"image", data:string, mimeType:string}>} [images]
	 */
	async followUp(message, images) {
		const response = await this.request({ type: "follow_up", message, images });
		if (!response.success) {
			throw Object.assign(new Error(response.error ?? "follow_up failed"), { stepRejected: true });
		}
	},

	/** 中断当前轮。 */
	async abort() {
		await this.request({ type: "abort" });
	},

	/** 清空排队消息并返回其文本。 @returns {Promise<{ steering: string[], followUp: string[] }>} */
	async clearQueue() {
		return this.getData(await this.request({ type: "clear_queue" }));
	},

	/**
	 * 新会话（壳侧 session/create 的映射目标之一）。
	 * @param {string} [parentSession]
	 * @returns {Promise<{ cancelled: boolean }>}
	 */
	async newSession(parentSession) {
		return this.getData(await this.request({ type: "new_session", parentSession }));
	},

	/** @returns {Promise<RpcSessionState>} */
	async getState() {
		return this.getData(await this.request({ type: "get_state" }));
	},

	/**
	 * 设置模型（壳侧 session/create 的映射目标之一）。
	 * @param {string} provider
	 * @param {string} modelId
	 */
	async setModel(provider, modelId) {
		return this.getData(await this.request({ type: "set_model", provider, modelId }));
	},

	/** @returns {Promise<any[]>} */
	async getAvailableModels() {
		return this.getData(await this.request({ type: "get_available_models" })).models;
	},

	/** @param {string} level */
	async setThinkingLevel(level) {
		await this.expectSuccess(await this.request({ type: "set_thinking_level", level }));
	},

	/** @returns {Promise<string[]>} */
	async getAvailableThinkingLevels() {
		return this.getData(await this.request({ type: "get_available_thinking_levels" })).levels;
	},

	/** @param {string} name */
	async setSessionName(name) {
		await this.expectSuccess(await this.request({ type: "set_session_name", name }));
	},

	/**
	 * 会话条目（壳侧 session/read 的映射目标）。
	 * @param {string} [since]
	 */
	async getEntries(since) {
		return this.getData(await this.request({ type: "get_entries", since }));
	},

	async getTree() {
		return this.getData(await this.request({ type: "get_tree" }));
	},

	/** @returns {Promise<any[]>} */
	async getMessages() {
		return this.getData(await this.request({ type: "get_messages" })).messages;
	},

	/** @returns {Promise<string | null>} */
	async getLastAssistantText() {
		return this.getData(await this.request({ type: "get_last_assistant_text" })).text;
	},

	async getSessionStats() {
		return this.getData(await this.request({ type: "get_session_stats" }));
	},

	/** @returns {Promise<any[]>} */
	async getCommands() {
		return this.getData(await this.request({ type: "get_commands" })).commands;
	},

	/**
	 * 执行 bash 命令（结果含 output/exitCode/cancelled/truncated）。
	 * @param {string} command
	 * @param {{ excludeFromContext?: boolean }} [options]
	 */
	async bash(command, options = {}) {
		return this.getData(await this.request({ type: "bash", command, excludeFromContext: options.excludeFromContext }));
	},
};
