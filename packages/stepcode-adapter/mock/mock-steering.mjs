/**
 * step-rpc-mock steering 间隙注入（R7 插话轮新增，非机械拆分）。
 *
 * 对齐底座真实契约（packages/agent-core/src/agent-loop.ts runLoop +
 * packages/coding-agent/src/core/agent-session.ts _handleAgentEvent，评审行号：
 * agent-loop.ts:167-209/270、agent-session.ts:706-723）：
 * - 每个 turn 结束（含工具调用 turn 的 toolResults 落定、turn_end 发出）后轮询
 *   steering 池；命中则在**同一个 agent run 内**开新 turn 注入用户消息（turn_start →
 *   message_start/message_end(user)），再流一条应答 assistant 消息，直到池空。
 *   注入点=「下一个 LLM 调用前」，即工具间隙；不是等 agent_end 之后。
 * - 每条注入消息的线上顺序：先 queue_update（池已移除该项，_handleAgentEvent 在
 *   转发 message_start 之前同步 emit），后 message_start/message_end(user)。
 * - steeringMode="all"（mock get_state 声明值）一次性整批注入。
 *
 * 与 mock 既有契约的边界（docs/step-input-admission-queue-spec.md §3 不变）：
 * - followUp 池续跑仍走 drainQueue（runPrompt 结束后 shift），本模块不碰 followUp。
 * - abort 清两池、steer/follow_up 命令入池逻辑仍在 mock-commands.mjs，不动。
 * - 池空时本模块零输出（所有既有用例的 steering 池为空，行为逐字节不变）。
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

import { write } from "./mock-io.mjs";
import { mockConfig } from "./mock-config.mjs";
import { state } from "./mock-state.mjs";
import { sleep } from "./mock-runtime.mjs";
import { userMessage, assistantMessage, messageUpdate, appendEntry } from "./mock-messages.mjs";

/** 把池内容回显为 queue_update（底座形状：steering/followUp 均为纯文本数组；
 * 与 mock-prompt-queue.mjs 的同名回显保持同一形状，供注入时「池已移除」回显复用）。 */
function emitQueueUpdate() {
	write({
		type: "queue_update",
		steering: state.steering.map((item) => item.message),
		followUp: state.followUp.map((item) => item.message),
	});
}

/** @param {string} text @param {number} size */
function chunkText(text, size) {
	const parts = [];
	for (let i = 0; i < text.length; i += size) {
		parts.push(text.slice(i, i + size));
	}
	return parts;
}

/**
 * turn 结束后的 steering 间隙注入（底座 runLoop 轮询语义）：
 * 池空 → 零输出直接返回；池非空 → 循环〔turn_start → 逐条（queue_update →
 * message_start/message_end(user)）→ 应答 assistant 流式 → turn_end〕直到池空。
 * 应答文本 `已收到插话：<消息>` 是 mock 的可观测行为回执（协议级测试用它断言
 * 「注入发生在当前 run 内、任务收敛前」）。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 * @returns {Promise<Array<{ message: string, images: any[] }>>} 本次注入的全部消息
 */
export async function injectSteeringAtGap(run) {
	/** @type {Array<{ message: string, images: any[] }>} */
	const injectedAll = [];
	while (state.steering.length > 0) {
		const batch = state.steering.splice(0);
		write({ type: "turn_start" });
		for (const item of batch) {
			// 底座顺序：message_start(user) 处理时先移除并回显池，再转发 message_start。
			emitQueueUpdate();
			const um = userMessage(item.message, item.images);
			write({ type: "message_start", message: um });
			write({ type: "message_end", message: um });
			appendEntry(um);
			await sleep(run, mockConfig.delayMs);
		}
		injectedAll.push(...batch);
		const reply = `已收到插话：${batch.map((item) => item.message).join("；")}`;
		write({ type: "message_start", message: assistantMessage([]) });
		write(messageUpdate("text_start", 0));
		for (const part of chunkText(reply, 8)) {
			await sleep(run, mockConfig.delayMs);
			write(messageUpdate("text_delta", 0, { delta: part }));
		}
		write(messageUpdate("text_end", 0, { content: reply }));
		const am = assistantMessage([{ type: "text", text: reply }]);
		write({ type: "message_end", message: am });
		appendEntry(am);
		write({ type: "turn_end", message: am, toolResults: [] });
	}
	return injectedAll;
}
