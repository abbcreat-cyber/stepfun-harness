/**
 * step-rpc-mock prompt 队列（自 step-rpc-mock.mjs 机械拆分，代码体逐字保留；
 * 仅 currentRun 改经 runtime 持有、delayMs 改经 mockConfig 读取）。
 *
 * 时序契约见 docs/step-input-admission-queue-spec.md §3：
 * - 池存 {message, images}；queue_update 回显纯文本数组（底座形状）。
 * - drainQueue 每轮 runPrompt 结束后 followUp 池非空则 shift 最老一项续跑；
 *   shift 时不发 queue_update（对齐底座 drain 语义，见 drainQueue 内注释）。
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

import { errorResponse, successResponse } from "../src/rpc-protocol.mjs";
import { write, diag } from "./mock-io.mjs";
import { mockConfig } from "./mock-config.mjs";
import { state } from "./mock-state.mjs";
import { RunCancelled, runtime, sleep } from "./mock-runtime.mjs";
import { textScenario, toolScenario, inputScenario, selectScenario } from "./mock-scenarios.mjs";

/** 把池内容回显为 queue_update（底座形状：steering/followUp 均为纯文本数组）。 */
export function emitQueueUpdate() {
	write({
		type: "queue_update",
		steering: state.steering.map((item) => item.message),
		followUp: state.followUp.map((item) => item.message),
	});
}

/** @type {Array<any>} */
const promptQueue = [];
let draining = false;

/** @param {any} cmd */
export function enqueuePrompt(cmd) {
	promptQueue.push(cmd);
	void drainQueue();
}

async function drainQueue() {
	if (draining) return;
	draining = true;
	try {
		// 每轮 prompt 结束后若 followUp 池非空，shift 最老一项续跑（对齐底座 drain 语义）。
		// 注意：shift 时不发 queue_update——底座真实顺序是 agent_start → message_start
		// 移除 → queue_update；若 shift 即发会把「移除」提前到 agent_start 之前，与底座
		// 相反（决议见 docs/step-input-admission-queue-spec.md §3.3）。迟到的池回显
		// （下一次 steer/follow_up/abort 触发）自然完成 reconcile。
		while (promptQueue.length > 0 || state.followUp.length > 0) {
			const cmd = promptQueue.length > 0 ? promptQueue.shift() : toPromptCommand(state.followUp.shift());
			await runPrompt(cmd);
		}
	} finally {
		draining = false;
	}
}

/** followUp 池项 → 等价的 prompt 命令（无 id：池续跑不发响应帧，对齐底座 drain）。 */
function toPromptCommand(item) {
	return { id: undefined, message: item.message, images: item.images };
}

/**
 * @param {any} cmd
 * @returns {Promise<void>}
 */
async function runPrompt(cmd) {
	const id = cmd.id;
	const message = String(cmd.message ?? "");
	const run = { cancelled: false, hooks: [] };
	runtime.currentRun = run;
	state.streaming = true;
	try {
		if (message.includes("mock:crash")) {
			diag("simulated crash (exit 1), no prompt response will be sent");
			process.exit(1);
		}
		if (id !== undefined && message.includes("mock:exit130")) {
			write(successResponse(id, "prompt")); // preflight 成功后才中断
			await sleep(run, mockConfig.delayMs);
			diag("simulated SIGINT (exit 130)");
			process.exit(130);
		}
		if (id !== undefined && message.includes("mock:error")) {
			// STEP_MOCK_PROMPT_ERROR 可覆盖错误原文（bridge 侧错误归类测试用它模拟
			// 401/404/429/网络等各类 CLI/云端失败文案）。
			write(
				errorResponse(
					id,
					"prompt",
					process.env.STEP_MOCK_PROMPT_ERROR ??
						"No API key found for mock-provider.\n\nUse /login to log into a provider via OAuth or API key. See: (simulated preflight failure)",
				),
			);
			return;
		}

		// preflight 成功（rpc-mode.ts:408-413）；池续跑（id===undefined）无请求方，不发响应帧。
		if (id !== undefined) write(successResponse(id, "prompt"));

		// 图片 echo 条件：带 images 且（显式 mock:image-transport 标记或纯图空文本）——
		// 支撑「纯图片空文本进入 RPC」断言（空文本+图片是合法输入）。
		if (Array.isArray(cmd.images) && cmd.images.length > 0 && (message === "mock:image-transport" || message.trim() === "")) {
            await textScenario(run, JSON.stringify({images:cmd.images}));
        } else if (message.includes("mock:confirm-timeout")) {
			await toolScenario(run, { needApproval: true, approvalTimeoutMs: 250 });
		} else if (message.includes("mock:confirm")) {
			await toolScenario(run, { needApproval: true });
		} else if (message.includes("mock:input")) {
			// P0-05：input 追问往返（cancelled/无 value 均得 undefined，rpc-mode.ts:147-153）。
			await inputScenario(run);
		} else if (message.includes("mock:select")) {
			await selectScenario(run);
		} else if (message.includes("mock:tool")) {
			await toolScenario(run, { needApproval: false });
		} else {
			await textScenario(run, message);
		}
	} catch (error) {
		if (!(error instanceof RunCancelled)) {
			diag(`scenario error: ${error?.stack ?? error}`);
		}
		// 取消（abort）或剧本异常都收敛到 agent_end + agent_settled，保证客户端状态机不悬挂。
		write({ type: "agent_end", messages: [], willRetry: false });
		write({ type: "agent_settled" });
	} finally {
		state.streaming = false;
		runtime.currentRun = null;
	}
}
