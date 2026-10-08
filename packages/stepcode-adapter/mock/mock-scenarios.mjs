/**
 * step-rpc-mock 剧本（自 step-rpc-mock.mjs 机械拆分，代码体逐字保留；
 * 仅 delayMs 改经 mockConfig 读取）。
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
import { sleep } from "./mock-runtime.mjs";
import { userMessage, assistantMessage, messageUpdate, appendEntry } from "./mock-messages.mjs";
import { requestConfirm, requestInput, requestSelect } from "./mock-extension-ui.mjs";
import { injectSteeringAtGap } from "./mock-steering.mjs";

/** @param {string} text @param {number} size */
function chunkText(text, size) {
	const parts = [];
	for (let i = 0; i < text.length; i += size) {
		parts.push(text.slice(i, i + size));
	}
	return parts;
}

/**
 * 文本问答剧本（A2）：agent_start → user 消息对 → assistant 流式增量 → 收尾。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 * @param {string} message
 */
export async function textScenario(run, message) {
	const reply = `mock reply to: ${message}`;

	write({ type: "agent_start" });
	write({ type: "turn_start" });

	const um = userMessage(message);
	write({ type: "message_start", message: um });
	write({ type: "message_end", message: um });
	appendEntry(um);
	await sleep(run, mockConfig.delayMs);

	const parts = chunkText(reply, 8);
	write({ type: "message_start", message: assistantMessage([]) });
	write(messageUpdate("text_start", 0));
	for (const part of parts) {
		await sleep(run, mockConfig.delayMs);
		write(messageUpdate("text_delta", 0, { delta: part }));
	}
	write(messageUpdate("text_end", 0, { content: reply }));
	const am = assistantMessage([{ type: "text", text: reply }]);
	write({ type: "message_end", message: am });
	appendEntry(am);

	write({ type: "turn_end", message: am, toolResults: [] });
	// R7 插话轮：turn 结束即轮询 steering 池（底座 runLoop 语义——同一 agent run 内
	// 注入，不是等任务结束）。池空时 injectSteeringAtGap 零输出，行为不变。
	await injectSteeringAtGap(run);
	write({ type: "agent_end", messages: [um, am], willRetry: false });
	write({ type: "agent_settled" });
}

/**
 * 工具调用剧本（A3 + A4）。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 * @param {{ needApproval: boolean, approvalTimeoutMs?: number }} options
 */
export async function toolScenario(run, { needApproval, approvalTimeoutMs }) {
	const toolCall = { type: "toolCall", id: "call_mock_1", name: "bash", arguments: { command: "echo mock" } };
	const toolArgsJson = JSON.stringify(toolCall.arguments);

	write({ type: "agent_start" });
	write({ type: "turn_start" });

	const um = userMessage("run the mock tool");
	write({ type: "message_start", message: um });
	write({ type: "message_end", message: um });
	appendEntry(um);
	await sleep(run, mockConfig.delayMs);

	// 第一条 assistant 消息：文本前奏 + 工具调用流（toolcall_start 附加 id/toolName）。
	const prelude = "Let me run a tool.";
	write({ type: "message_start", message: assistantMessage([]) });
	write(messageUpdate("text_start", 0));
	for (const part of chunkText(prelude, 8)) {
		await sleep(run, mockConfig.delayMs);
		write(messageUpdate("text_delta", 0, { delta: part }));
	}
	write(messageUpdate("text_end", 0, { content: prelude }));
	write(messageUpdate("toolcall_start", 1, { id: toolCall.id, toolName: toolCall.name }));
	for (const part of chunkText(toolArgsJson, 10)) {
		await sleep(run, mockConfig.delayMs);
		write(messageUpdate("toolcall_delta", 1, { delta: part }));
	}
	write(messageUpdate("toolcall_end", 1, { toolCall }));
	const assistant1 = assistantMessage([{ type: "text", text: prelude }, toolCall], "toolUse");
	write({ type: "message_end", message: assistant1 });
	appendEntry(assistant1);

	// 批准往返（A4）：需要确认的工具先问。标题/正文对齐底座真实后缀形状——
	// title=Approve <tool> [<call id 后 8 位>]、message=Call: <call id>\n<参数 JSON>
	//（底座用 call id 的尾缀做弹窗去重键；旧形状 "Approve bash [echo mock]" 不带
	// Call: 换行，isNativeToolPermission 双正则不命中，桥接四模式策略测不到真分支）。
	let approved = true;
	if (needApproval) {
		approved = await requestConfirm(run, {
			title: `Approve bash [${toolCall.id.slice(-8)}]`,
			message: `Call: ${toolCall.id}\n${toolArgsJson}`,
			timeoutMs: approvalTimeoutMs,
		});
	}

	/** @type {any} */
	const assistant2Content = [];
	if (!approved) {
		write({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result: { type: "text", text: "Permission denied" },
			isError: true,
		});
		const denial = "Tool was denied by the user.";
		write({ type: "message_start", message: assistantMessage([]) });
		write(messageUpdate("text_start", 0));
		for (const part of chunkText(denial, 8)) {
			await sleep(run, mockConfig.delayMs);
			write(messageUpdate("text_delta", 0, { delta: part }));
		}
		write(messageUpdate("text_end", 0, { content: denial }));
		assistant2Content.push({ type: "text", text: denial });
	} else {
		write({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
		await sleep(run, mockConfig.delayMs);
		write({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult: { type: "text", text: "mock\n" },
		});
		await sleep(run, mockConfig.delayMs);
		write({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result: { type: "text", text: "mock\n" },
			isError: false,
		});
		const followUp = "Tool finished: mock";
		write({ type: "message_start", message: assistantMessage([]) });
		write(messageUpdate("text_start", 0));
		for (const part of chunkText(followUp, 8)) {
			await sleep(run, mockConfig.delayMs);
			write(messageUpdate("text_delta", 0, { delta: part }));
		}
		write(messageUpdate("text_end", 0, { content: followUp }));
		assistant2Content.push({ type: "text", text: followUp });
	}

	const assistant2 = assistantMessage(assistant2Content);
	write({ type: "message_end", message: assistant2 });
	appendEntry(assistant2);
	write({
		type: "turn_end",
		message: assistant2,
		toolResults: [
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [approved ? { type: "text", text: "mock\n" } : { type: "text", text: "Permission denied" }],
				isError: !approved,
			},
		],
	});
	// R7 插话轮：工具 turn 结束后的间隙注入（底座在 toolResults 落定、下一次 LLM 调用前
	// 注入 steering 消息——这是「插话在当前任务内生效」的关键注入点）。
	await injectSteeringAtGap(run);
	write({ type: "agent_end", messages: [um, assistant1, assistant2], willRetry: false });
	write({ type: "agent_settled" });
}

/**
 * 流式收尾助手文本并落 turn/agent 终态（input/select 剧本共用尾段）。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 * @param {any} um 起始 user 消息
 * @param {string} reply
 */
async function finishWithReply(run, um, reply) {
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
	// R7 插话轮：input/select 剧本收尾同样轮询 steering（底座每个 turn 后都轮询）。
	await injectSteeringAtGap(run);
	write({ type: "agent_end", messages: [um, am], willRetry: false });
	write({ type: "agent_settled" });
}

/**
 * input 追问剧本（P0-05）：发 extension_ui_request(input)（title/message/placeholder
 * 齐全，支撑桥接 prompt 折叠断言），等 extension_ui_response——cancelled 或无 string
 * value 均得 undefined（对齐 rpc-mode.ts:147-153），回复文本回显收到与否。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 */
export async function inputScenario(run) {
	write({ type: "agent_start" });
	write({ type: "turn_start" });
	const um = userMessage("mock input request");
	write({ type: "message_start", message: um });
	write({ type: "message_end", message: um });
	appendEntry(um);
	await sleep(run, mockConfig.delayMs);
	const value = await requestInput(run, {
		title: "分支名",
		message: "请输入要创建的分支名",
		placeholder: "feat/x",
	});
	await finishWithReply(run, um, value === undefined ? "Input cancelled (no value)" : `Input received: ${value}`);
}

/**
 * select 追问剧本（P0-05）：发 extension_ui_request(select)（options 数组对齐底座
 * 纯文本选项形状），语义与 inputScenario 相同。
 * @param {{ cancelled: boolean, hooks: Array<() => void> }} run
 */
export async function selectScenario(run) {
	write({ type: "agent_start" });
	write({ type: "turn_start" });
	const um = userMessage("mock select request");
	write({ type: "message_start", message: um });
	write({ type: "message_end", message: um });
	appendEntry(um);
	await sleep(run, mockConfig.delayMs);
	const value = await requestSelect(run, {
		title: "部署环境",
		message: "请选择部署环境",
		options: ["staging", "prod"],
	});
	await finishWithReply(run, um, value === undefined ? "Selection cancelled (no value)" : `Selected: ${value}`);
}
