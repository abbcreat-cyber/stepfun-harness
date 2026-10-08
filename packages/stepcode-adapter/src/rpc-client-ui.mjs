/**
 * StepCodeRpcClient 的扩展 UI 请求方法族（工具批准往返：handleUiRequests/
 * respondUiRequest/dispatchUiRequest，extension_ui_request → extension_ui_response）。
 * 自 rpc-client.mjs 机械拆出：方法体未改动，经 rpc-client.mjs 挂回
 * StepCodeRpcClient.prototype，公共接口不变。
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

import { uiRequestNeedsResponse } from "./rpc-protocol.mjs";

/** @typedef {import("./rpc-protocol.mjs").RpcExtensionUIRequest} RpcExtensionUIRequest */
/** @typedef {import("./rpc-protocol.mjs").UiResolution} UiResolution */

/**
 * 扩展 UI 请求方法族（this 绑定 StepCodeRpcClient 实例）。
 * @type {Record<string, any>}
 */
export const rpcUiMethods = {
	/**
	 * 设置扩展 UI 请求处理器（工具批准往返）。传 null 清除。
	 * 未设置（或返回 null/undefined）时对需要响应的请求回 {cancelled:true}——fail-closed，
	 * 对齐 Step-Code 无 UI 时权限默认拒绝（permissions.ts:548-565）。
	 * @param {((req: RpcExtensionUIRequest) => any) | null} handler
	 */
	handleUiRequests(handler) {
		this.uiHandler = handler;
	},

	/**
	 * 手动响应一个扩展 UI 请求（低层 API；与 handleUiRequests 互斥使用亦可）。
	 * 幂等：同一 id 的第二个响应被忽略。
	 * @param {string} id extension_ui_request 的 id
	 * @param {UiResolution} resolution {confirmed} / {value} / {cancelled}
	 */
	respondUiRequest(id, resolution) {
		if (this.respondedUiIds.has(id)) {
			return;
		}
		this.respondedUiIds.add(id);
		this.writeRawLine(JSON.stringify({ type: "extension_ui_response", id, ...resolution }));
	},

	/** @private @param {RpcExtensionUIRequest} req */
	dispatchUiRequest(req) {
		if (!uiRequestNeedsResponse(req)) {
			return;
		}
		if (this.uiHandler) {
			Promise.resolve()
				.then(() => this.uiHandler(req))
				.then((resolution) => {
					this.respondUiRequest(req.id, normalizeUiResolution(resolution));
				})
				.catch((error) => {
					// handler 抛错按取消处理（fail-closed），不吞真实错误：写入 stderr 视图。
					this.stderrText += `\n[stepcode-adapter] ui handler error: ${error?.message ?? error}`;
					this.respondUiRequest(req.id, { cancelled: true });
				});
			return;
		}
		// 未注册 handler：默认 fail-closed 自动回 {cancelled:true}（对齐 Step-Code 无 UI 时
		// 权限默认拒绝，permissions.ts:548-565）。需要完全手动控制时设 manualUiResponses:true。
		if (!this.options.manualUiResponses) {
			this.respondUiRequest(req.id, { cancelled: true });
		}
	},
};

/**
 * 把 handler 返回值归一为合法的 UI 响应形状；null/undefined → {cancelled:true}。
 * @param {any} resolution
 * @returns {UiResolution}
 */
function normalizeUiResolution(resolution) {
	if (typeof resolution === "object" && resolution !== null) {
		if (typeof resolution.value === "string") return { value: resolution.value };
		if (typeof resolution.confirmed === "boolean") return { confirmed: resolution.confirmed };
		if (resolution.cancelled === true) return { cancelled: true };
	}
	return { cancelled: true };
}
