/**
 * StepCodeRpcClient 的等待/收集方法族（waitForIdle/collectEvents，均以 agent_settled
 * 为一轮结束的权威信号）。自 rpc-client.mjs 机械拆出：方法体未改动，经 rpc-client.mjs
 * 挂回 StepCodeRpcClient.prototype，公共接口不变。
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

/** @typedef {import("./rpc-protocol.mjs").JsonAgentSessionEvent} JsonAgentSessionEvent */

/**
 * 等待/收集方法族（this 绑定 StepCodeRpcClient 实例）。
 * @type {Record<string, any>}
 */
export const rpcWaitMethods = {
	/**
	 * 等待 agent 空闲（收到 agent_settled）。一轮结束的权威信号。
	 * @param {number} [timeoutMs]
	 * @returns {Promise<void>}
	 */
	waitForIdle(timeoutMs = 60000) {
		return this.collectEvents(timeoutMs).then(() => undefined);
	},

	/**
	 * 收集事件直到 agent_settled。
	 * @param {number} [timeoutMs]
	 * @returns {Promise<JsonAgentSessionEvent[]>}
	 */
	collectEvents(timeoutMs = 60000, { signal } = {}) {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) { reject(new Error("Event collection cancelled")); return; }
			if (this.exitError) { reject(this.exitError); return; }
			const events = [];
			let settled = false;
			let unsubscribeFailure = () => {};
			const finish = error => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				unsubscribeFailure();
				signal?.removeEventListener("abort", abort);
				if (error) reject(error); else resolve(events);
			};
			const abort = () => finish(new Error("Event collection cancelled"));
			const timer = setTimeout(() => finish(new Error(`Timeout collecting events (${timeoutMs}ms). Stderr: ${this.stderrTail()}`)), timeoutMs);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_settled") {
					finish();
				}
			});
			unsubscribeFailure = this.onFailure(finish);
			if (settled) unsubscribeFailure();
			signal?.addEventListener("abort", abort, { once: true });
		});
	},
};
