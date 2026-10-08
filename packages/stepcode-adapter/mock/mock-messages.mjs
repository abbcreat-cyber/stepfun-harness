/**
 * step-rpc-mock 消息构造（自 step-rpc-mock.mjs 机械拆分，代码体逐字保留）。
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

import { zeroUsage } from "../src/rpc-protocol.mjs";
import { state } from "./mock-state.mjs";

/** @param {string} text @param {any[]} [images] R7 插话轮：steering 注入的 user 消息可带图（底座 _queueSteer 形状）。 */
export function userMessage(text, images) {
	const content = [{ type: "text", text }];
	if (Array.isArray(images) && images.length > 0) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

/** @param {any[]} content @param {string} [stopReason] */
export function assistantMessage(content, stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: state.model.provider,
		model: state.model.id,
		usage: zeroUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * message_update 线上形状（json-event.ts 投影后：usage + 剥掉 partial 的事件）。
 * @param {string} type @param {number} contentIndex @param {Record<string, any>} [extra]
 */
export function messageUpdate(type, contentIndex, extra = {}) {
	return {
		type: "message_update",
		usage: zeroUsage(),
		assistantMessageEvent: { type, contentIndex, ...extra },
	};
}

/** @param {any} message */
export function appendEntry(message) {
	const entry = { type: "message", id: `entry_${state.entries.length + 1}`, message };
	state.entries.push(entry);
	return entry;
}
