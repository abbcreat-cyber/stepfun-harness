/**
 * step-rpc-mock 会话状态（自 step-rpc-mock.mjs 机械拆分，代码体逐字保留）。
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

export const MODELS = [
	{
		provider: "step",
		id: "step-5-preview",
		name: "Step 5 Preview",
		api: "openai-completions",
		contextWindow: 200000,
		maxTokens: 65536,
		reasoning: true,
		cost: { input: 0, output: 0 },
	},
	{
		provider: "mock",
		id: "mock-mini",
		name: "Mock Mini",
		api: "openai-completions",
		contextWindow: 32768,
		maxTokens: 8192,
		reasoning: false,
		cost: { input: 0, output: 0 },
	},
];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const state = {
	model: MODELS[0],
	thinkingLevel: "medium",
	sessionId: `mock-session-${Date.now().toString(36)}`,
	/** @type {string | undefined} */
	sessionName: undefined,
	/** @type {Array<{ type: string, id: string, message: any }>} */
	entries: [],
	// 池存 {message, images}：底座 steer/follow_up 命令携带图片入池（mock 对齐），
	// queue_update 仍回显纯文本数组（底座形状，见 handleCommand 的池回显处）。
	/** @type {Array<{ message: string, images: any[] }>} */
	steering: [],
	/** @type {Array<{ message: string, images: any[] }>} */
	followUp: [],
	streaming: false,
};
