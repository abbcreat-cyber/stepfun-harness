/**
 * step-rpc-mock 扩展 UI 往返（自 step-rpc-mock.mjs 机械拆分，代码体逐字保留）。
 *
 * rpc-mode.ts:79-131 的 pendingExtensionRequests 语义；主入口的 stdin 循环在命令
 * 分发前先查 pendingExtensionRequests 完成 extension_ui_response 配对。
 *
 * 本文件派生自 stepfun-ai/Step-Code（https://github.com/stepfun-ai/Step-Code，
 * packages/coding-agent/src/modes/rpc-mode.ts 及 rpc/ 下的 jsonl/rpc-types/rpc-client），
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

import { randomUUID } from "node:crypto";
import { write, diag } from "./mock-io.mjs";

/** @type {Map<string, (response: any) => void>} */
export const pendingExtensionRequests = new Map();

/**
 * 发一个 confirm 请求并等待响应/超时/取消。等待期间持续发 bash_execution_update，
 * 供客户端验证"批准期间事件流不断"。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 * @param {{ title: string, message: string, timeoutMs?: number }} spec
 * @returns {Promise<boolean>}
 */
export function requestConfirm(run, spec) {
	const id = randomUUID();
	write({
		type: "extension_ui_request",
		id,
		method: "confirm",
		title: spec.title,
		message: spec.message,
		...(spec.timeoutMs !== undefined ? { timeout: spec.timeoutMs } : {}),
	});
	return new Promise((resolve) => {
		let settled = false;
		/** @type {NodeJS.Timeout | undefined} */
		let timeoutTimer;
		const ticker = setInterval(() => {
			// 批准等待期间事件流不断（工具输出通道持续有增量）。
			write({ type: "bash_execution_update", id: "call_mock_1", delta: "waiting for approval...\n" });
		}, 80);

		const finish = (/** @type {boolean} */ value) => {
			if (settled) return;
			settled = true;
			clearInterval(ticker);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			pendingExtensionRequests.delete(id);
			resolve(value);
		};

		pendingExtensionRequests.set(id, (response) => {
			// cancelled 或 confirmed:false 都按拒绝；只有 confirmed:true 放行。
			finish(response?.cancelled !== true && response?.confirmed === true);
		});
		if (spec.timeoutMs !== undefined) {
			timeoutTimer = setTimeout(() => {
				diag(`confirm ${id} timed out after ${spec.timeoutMs}ms -> deny (default false)`);
				finish(false);
			}, spec.timeoutMs);
		}
		run.hooks.push(() => finish(false));
	});
}

/**
 * input/select 请求的公共等待体：响应里 cancelled 或无 string value 均得 undefined
 * （对齐 rpc-mode.ts:147-153 的 base 语义——取消与缺值对底座不可区分）。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 * @param {string} id
 * @returns {Promise<string | undefined>}
 */
function waitForValue(run, id) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (/** @type {string | undefined} */ value) => {
			if (settled) return;
			settled = true;
			pendingExtensionRequests.delete(id);
			resolve(value);
		};
		pendingExtensionRequests.set(id, (response) => {
			finish(typeof response?.value === "string" ? response.value : undefined);
		});
		run.hooks.push(() => finish(undefined));
	});
}

/**
 * 发一个 input 请求并等待响应/取消。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 * @param {{ title: string, message?: string, placeholder?: string }} spec
 * @returns {Promise<string | undefined>}
 */
export function requestInput(run, spec) {
	const id = randomUUID();
	write({
		type: "extension_ui_request",
		id,
		method: "input",
		title: spec.title,
		...(spec.message !== undefined ? { message: spec.message } : {}),
		...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
	});
	return waitForValue(run, id);
}

/**
 * 发一个 select 请求并等待响应/取消。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 * @param {{ title: string, message?: string, options: string[] }} spec
 * @returns {Promise<string | undefined>}
 */
export function requestSelect(run, spec) {
	const id = randomUUID();
	write({
		type: "extension_ui_request",
		id,
		method: "select",
		title: spec.title,
		options: spec.options,
		...(spec.message !== undefined ? { message: spec.message } : {}),
	});
	return waitForValue(run, id);
}
