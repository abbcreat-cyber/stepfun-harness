/**
 * Step-Code rpc 模式（`step --mode rpc`，stdin/stdout JSONL）协议类型与工具函数。
 *
 * 形状依据 Step-Code/packages/coding-agent/src/modes/rpc/rpc-types.ts（命令/响应/扩展 UI）
 * 与 src/modes/json-event.ts（事件投影：message_update 剥掉 partial 累计快照、
 * toolcall_start 附加 id/toolName）。本文件用 JSDoc 表达同一契约，供适配层与 mock 共享。
 *
 * 本文件派生自 stepfun-ai/Step-Code（https://github.com/stepfun-ai/Step-Code，
 * packages/coding-agent/src/modes/rpc/rpc-types.ts 与 src/modes/json-event.ts），
 * 依其 MIT License 授权，原版权与许可声明随本文件保留：
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

// ============================================================================
// 命令（stdin → mock/agent）
// ============================================================================

/** @typedef {"prompt"|"steer"|"follow_up"|"abort"|"clear_queue"|"new_session"|"get_state"|"set_model"|"cycle_model"|"get_available_models"|"set_thinking_level"|"cycle_thinking_level"|"get_available_thinking_levels"|"set_steering_mode"|"set_follow_up_mode"|"compact"|"set_auto_compaction"|"set_auto_retry"|"abort_retry"|"bash"|"abort_bash"|"get_session_stats"|"export_html"|"switch_session"|"fork"|"clone"|"get_fork_messages"|"get_entries"|"get_tree"|"get_last_assistant_text"|"set_session_name"|"get_messages"|"get_commands"} RpcCommandType */

/**
 * stdin 上的命令信封。`id` 可选；带 id 的命令其响应会回显同一 id。
 * @typedef {{ id?: string } & object} RpcCommand
 */

/**
 * prompt 命令体。
 * @typedef {{ id?: string, type: "prompt", message: string, images?: Array<{type:"image", data:string, mimeType:string}>, streamingBehavior?: "steer"|"followUp" }} RpcPromptCommand
 */

// ============================================================================
// 响应（mock/agent → stdout）
// ============================================================================

/**
 * stdout 上的命令响应。失败时 `success:false` 且带 `error` 字符串。
 * @typedef {{ id?: string, type: "response", command: string, success: true, data?: any } | { id?: string, type: "response", command: string, success: false, error: string }} RpcResponse
 */

/** @typedef {{ model?: any, thinkingLevel: string, isStreaming: boolean, isCompacting: boolean, steeringMode: "all"|"one-at-a-time", followUpMode: "all"|"one-at-a-time", sessionFile?: string, sessionId: string, sessionName?: string, autoCompactionEnabled: boolean, messageCount: number, pendingMessageCount: number }} RpcSessionState */

// ============================================================================
// 扩展 UI 请求/响应（stdout 请求 → stdin 响应，工具批准往返）
// ============================================================================

/** 需要客户端回 extension_ui_response 的方法；其余（notify/setStatus/setWidget/setTitle/set_editor_text）为单向 fire-and-forget。 @type {ReadonlySet<string>} */
export const UI_METHODS_REQUIRING_RESPONSE = new Set(["select", "confirm", "input", "editor"]);

/**
 * stdout 上的扩展 UI 请求（权限确认、选择、输入等）。
 * @typedef {{ type: "extension_ui_request", id: string, method: "select"|"confirm"|"input"|"editor"|"notify"|"setStatus"|"setWidget"|"setTitle"|"set_editor_text", title?: string, message?: string, options?: string[], timeout?: number }} RpcExtensionUIRequest
 */

/**
 * stdin 上的扩展 UI 响应。三种互斥形状：value / confirmed / cancelled。
 * @typedef {{ type: "extension_ui_response", id: string, value: string } | { type: "extension_ui_response", id: string, confirmed: boolean } | { type: "extension_ui_response", id: string, cancelled: true }} RpcExtensionUIResponse
 */

/**
 * UI 响应的解析结果（不含 type/id 外壳），由宿主决定。
 * @typedef {{ value: string } | { confirmed: boolean } | { cancelled: true }} UiResolution
 */

// ============================================================================
// 事件（mock/agent → stdout，流式增量）
// ============================================================================

/**
 * session 事件投影（json-event.ts 之后的线上形状）。
 * message_update 携带 usage 与剥掉 partial 的 assistantMessageEvent；
 * toolcall_start 额外携带 id/toolName。
 * @typedef {{ type: "message_update", usage: any, assistantMessageEvent: any }} JsonMessageUpdateEvent
 * @typedef {{ type: string } & Record<string, any>} JsonAgentSessionEvent
 */

/** usage 形状（@step-harness/providers Usage 的零值样例）。 @returns {{ input:number, output:number, cacheRead:number, cacheWrite:number, totalTokens:number, cost:{input:number,output:number,cacheRead:number,cacheWrite:number,total:number} }} */
export function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ============================================================================
// 判定函数
// ============================================================================

/**
 * 是否为命令响应（type === "response"）。
 * @param {any} obj
 * @returns {obj is RpcResponse}
 */
export function isRpcResponse(obj) {
	return (
		typeof obj === "object" &&
		obj !== null &&
		obj.type === "response" &&
		typeof obj.command === "string"
	);
}

/**
 * 是否为扩展 UI 请求（type === "extension_ui_request"）。
 * @param {any} obj
 * @returns {obj is RpcExtensionUIRequest}
 */
export function isExtensionUiRequest(obj) {
	return (
		typeof obj === "object" &&
		obj !== null &&
		obj.type === "extension_ui_request" &&
		typeof obj.id === "string" &&
		typeof obj.method === "string"
	);
}

/**
 * 是否为需要响应的 UI 请求（select/confirm/input/editor）。
 * @param {any} obj
 * @returns {boolean}
 */
export function uiRequestNeedsResponse(obj) {
	return isExtensionUiRequest(obj) && UI_METHODS_REQUIRING_RESPONSE.has(obj.method);
}

/**
 * 是否为扩展 UI 响应（stdin 方向，type === "extension_ui_response"）。
 * @param {any} obj
 * @returns {obj is RpcExtensionUIResponse}
 */
export function isExtensionUiResponse(obj) {
	return (
		typeof obj === "object" &&
		obj !== null &&
		obj.type === "extension_ui_response" &&
		typeof obj.id === "string"
	);
}

// ============================================================================
// 响应构造器（mock 侧使用，字段顺序对齐 rpc-mode.ts 的 success()/error()）
// ============================================================================

/**
 * 构造 success 响应。仅 data === undefined 时省略 data 字段；data === null 保留
 * （对齐 Step-Code rpc-mode.ts:69——cycle_model 等命令在真实 CLI 上可能回
 * {success:true, data:null}，省略会造成 mock 与真实形状分叉）。
 *
 * @param {string | undefined} id
 * @param {string} command
 * @param {object | null | undefined} [data]
 * @returns {RpcResponse}
 */
export function successResponse(id, command, data) {
	if (data === undefined) {
		return { id, type: "response", command, success: true };
	}
	return { id, type: "response", command, success: true, data };
}

/**
 * @param {string | undefined} id
 * @param {string} command
 * @param {string} message
 * @returns {RpcResponse}
 */
export function errorResponse(id, command, message) {
	return { id, type: "response", command, success: false, error: message };
}
