/**
 * step-rpc-mock 剧本运行控制（自 step-rpc-mock.mjs 机械拆分，代码体逐字保留）。
 *
 * RunCancelled + 可取消 sleep + 当前运行句柄 runtime.currentRun（原为模块级
 * `let currentRun`：runPrompt 置位/清空、abort 命令同步读取触发 hooks；对象持有
 * 保持跨模块 live 读写语义）。
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

export class RunCancelled extends Error {}

/**
 * 当前剧本运行句柄（原为模块级 let currentRun）：runPrompt 置位/清空，
 * abort 命令读取并同步触发 hooks。
 */
export const runtime = {
	/** @type {{ cancelled: boolean, hooks: Array<() => void> } | null} */
	currentRun: null,
};

/**
 * 可取消延迟：run 被取消后抛 RunCancelled，剧本随即走 agent_end/settled 收尾。
 * @param {{ cancelled: boolean, hooks: Array<() => void> } | null} run
 * @param {number} ms
 */
export const sleep = (run, ms) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			if (run?.cancelled) {
				reject(new RunCancelled());
			} else {
				resolve(undefined);
			}
		}, ms);
		run?.hooks.push(() => {
			clearTimeout(timer);
			reject(new RunCancelled());
		});
	});
