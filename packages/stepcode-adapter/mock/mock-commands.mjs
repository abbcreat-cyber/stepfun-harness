/**
 * step-rpc-mock 命令处理（自 step-rpc-mock.mjs 机械拆分，代码体逐字保留；
 * 仅 hangCommand 改经 mockConfig 读取、currentRun 改经 runtime 读取。
 * R8-3 修复轮追加（已记偏离）：set_model/get_available_models 的模型清单改经
 * resolveMockModels() 读取——STEP_MOCK_MODELS_FILE 未设时返回常量 MODELS，
 * 行为与现状逐字节一致；已设时每次调用惰性读文件合并自定义供应商条目）。
 *
 * abort 清池契约（docs/step-input-admission-queue-spec.md §3.2）：对齐底座 harness
 * abort 清池——两池清空并发 queue_update（回显空池）让客户端队列投影 reconcile；
 * abort 本身仍只回 success 不带数据。
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

import { readFileSync } from "node:fs";
import { errorResponse, successResponse } from "../src/rpc-protocol.mjs";
import { write, diag } from "./mock-io.mjs";
import { mockConfig } from "./mock-config.mjs";
import { MODELS, THINKING_LEVELS, state } from "./mock-state.mjs";
import { runtime } from "./mock-runtime.mjs";
import { enqueuePrompt, emitQueueUpdate } from "./mock-prompt-queue.mjs";

function stripBom(content) {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * 当前生效的模型清单：STEP_MOCK_MODELS_FILE 未设 → 常量 MODELS（与现状完全一致）；
 * 已设 → 每次调用惰性读文件（晚绑定），把文件里的自定义供应商条目按真实 CLI 的
 * models.json 形状 {providers:{id:{api,baseUrl,apiKey,models:[{id}]}}} 合并进基础清单。
 *
 * 与真实 CLI 的对齐边界（诚实记录差异，mock 是契约替身非真实 CLI）：
 * - apiKey 空白 → 该 provider 整体不可用（其模型不进清单，set_model 回 Model not found）。
 *   真实 CLI 对空串 "" 是 schema 层拒绝（minLength 1 → 整个文件无效 → 同样 Model not found）；
 *   对纯空白字符串则视作字面量 Key（provider 可用）。mock 统一按「不可用」收敛——
 *   宿主侧同步函数从不写空白 Key，该分歧在协议级测试的观测面外。
 * - 文件缺失/畸形/形状不符 → 回落基础清单（不崩、不半量合并）。
 * - typebox 校验严格性、baseUrl /v1 剥离归一化等未在 mock 复刻——那些是真实 CLI
 *   的实现细节，协议级测试只锁 set_model/get_available_models 的可观测契约。
 * - 任何路径都不输出 apiKey（合条目时 apiKey 只用于上述门控判定，不进模型对象）。
 * @returns {Array<{ provider: string, id: string, name: string, api: string, contextWindow: number, maxTokens: number, reasoning: boolean, cost: { input: number, output: number } }>}
 */
export function resolveMockModels() {
	const file = mockConfig.modelsFile;
	if (!file) return MODELS;
	let parsed;
	try {
		parsed = JSON.parse(stripBom(readFileSync(file, "utf8")));
	} catch {
		return MODELS; // 文件缺失/读取失败/非法 JSON：回落基础清单。
	}
	const providers = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.providers : undefined;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return MODELS;

	const merged = MODELS.map((m) => ({ ...m }));
	for (const [providerId, config] of Object.entries(providers)) {
		if (!config || typeof config !== "object" || Array.isArray(config)) continue;
		// 凭据门控（镜像真实 CLI 的 available 过滤语义，见上注释的分歧记录）。
		const apiKey = typeof config.apiKey === "string" ? config.apiKey : "";
		if (!apiKey.trim()) continue;
		const api = typeof config.api === "string" && config.api.trim() ? config.api : "openai-completions";
		const models = Array.isArray(config.models) ? config.models : [];
		for (const model of models) {
			if (!model || typeof model !== "object" || Array.isArray(model)) continue;
			const id = typeof model.id === "string" ? model.id.trim() : "";
			if (!id) continue;
			if (merged.some((m) => m.provider === providerId && m.id === id)) continue;
			const name = typeof model.name === "string" && model.name.trim() ? model.name : id;
			merged.push({
				provider: providerId,
				id,
				name,
				api,
				contextWindow: 128000,
				maxTokens: 16384,
				reasoning: false,
				cost: { input: 0, output: 0 },
			});
		}
	}
	return merged;
}

/**
 * @param {any} cmd
 * @returns {Promise<import("../src/rpc-protocol.mjs").RpcResponse | undefined>}
 */
export async function handleCommand(cmd) {
	const id = cmd.id;

	if (mockConfig.hangCommand !== null && cmd.type === mockConfig.hangCommand) {
		diag(`hanging on ${cmd.type} (no response, per --hang)`);
		return undefined;
	}

	switch (cmd.type) {
		case "prompt": {
			if (cmd.streamingBehavior && String(cmd.message ?? "").includes("mock:queue-reject")) return errorResponse(id, "prompt", "Refused steering for extension command (simulated)");
			// 与 session.prompt 对齐：只在真实 streaming 时进入原生池，闲时选项不阻塞首发。
			if (state.streaming && cmd.streamingBehavior === "steer") {
				state.steering.push({ message: String(cmd.message ?? ""), images: cmd.images ?? [] });
				emitQueueUpdate();
				return successResponse(id, "prompt");
			}
			if (state.streaming && cmd.streamingBehavior === "followUp") {
				state.followUp.push({ message: String(cmd.message ?? ""), images: cmd.images ?? [] });
				emitQueueUpdate();
				return successResponse(id, "prompt");
			}
			enqueuePrompt(cmd);
			return undefined; // 响应由剧本 preflight 异步发出（rpc-mode.ts:399-421）
		}

		case "steer": {
			// 拒绝注入：消息含 mock:queue-reject 时模拟底座对 extension command 的
			// 显式拒绝（success:false errorResponse），支撑「busy 分流被拒不伪造 ACK」。
			if (String(cmd.message ?? "").includes("mock:queue-reject")) {
				return errorResponse(id, "steer", "Refused steering for extension command (simulated)");
			}
			state.steering.push({ message: String(cmd.message ?? ""), images: cmd.images ?? [] });
			emitQueueUpdate();
			return successResponse(id, "steer");
		}

		case "follow_up": {
			if (String(cmd.message ?? "").includes("mock:queue-reject")) {
				return errorResponse(id, "follow_up", "Refused follow-up for extension command (simulated)");
			}
			state.followUp.push({ message: String(cmd.message ?? ""), images: cmd.images ?? [] });
			emitQueueUpdate();
			return successResponse(id, "follow_up");
		}

		case "abort": {
			const currentRun = runtime.currentRun;
			if (currentRun) {
				currentRun.cancelled = true;
				for (const hook of currentRun.hooks) {
					try {
						hook();
					} catch {
						// hook 抛错不影响其它 hook。
					}
				}
			}
			// 对齐底座 harness abort 清池：两池清空并发 queue_update（回显空池），
			// 让客户端的队列投影随之 reconcile；abort 本身仍只回 success 不带数据。
			state.steering = [];
			state.followUp = [];
			emitQueueUpdate();
			return successResponse(id, "abort");
		}

		case "clear_queue": {
			const data = {
				steering: state.steering.splice(0).map((item) => item.message),
				followUp: state.followUp.splice(0).map((item) => item.message),
			};
			return successResponse(id, "clear_queue", data);
		}

		case "new_session": {
			state.entries = [];
			state.sessionId = `mock-session-${Date.now().toString(36)}`;
			state.sessionName = undefined;
			return successResponse(id, "new_session", { cancelled: false });
		}

		case "switch_session": {
			// 底座 switch_session（按 sessionPath 恢复会话历史；桥接 restoreSession 用）。
			// 刻意保守对齐：恢复只换会话标识/名称，**不动进程级模型与思考档位**——底座
			// 对恢复后的模型态无契约保证，桥接必须自行重放 set_model（P0-04 恢复用例
			// 依赖这一差异区分「桥接重放过」与「碰巧没变」）。会话条目池 mock 不持久化，
			// 保持内存现状即可。
			state.sessionId = `mock-session-${Date.now().toString(36)}`;
			state.sessionName = undefined;
			return successResponse(id, "switch_session", { cancelled: false });
		}

		case "get_state": {
			return successResponse(id, "get_state", {
				model: state.model,
				thinkingLevel: state.thinkingLevel,
				isStreaming: state.streaming,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionFile: `mock://sessions/${state.sessionId}.jsonl`,
				sessionId: state.sessionId,
				sessionName: state.sessionName,
				autoCompactionEnabled: true,
				messageCount: state.entries.length,
				pendingMessageCount: 0,
			});
		}

		case "set_model": {
			const models = resolveMockModels();
			const model = models.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
			if (!model) {
				return errorResponse(id, "set_model", `Model not found: ${cmd.provider}/${cmd.modelId}`);
			}
			state.model = model;
			return successResponse(id, "set_model", model);
		}

		case "get_available_models": {
			return successResponse(id, "get_available_models", { models: resolveMockModels() });
		}

		case "set_thinking_level": {
			if (!THINKING_LEVELS.includes(cmd.level)) {
				return errorResponse(id, "set_thinking_level", `Unknown thinking level: ${cmd.level}`);
			}
			state.thinkingLevel = cmd.level;
			return successResponse(id, "set_thinking_level");
		}

		case "get_available_thinking_levels": {
			return successResponse(id, "get_available_thinking_levels", { levels: THINKING_LEVELS });
		}

		case "set_session_name": {
			const name = String(cmd.name ?? "").trim();
			if (!name) {
				return errorResponse(id, "set_session_name", "Session name cannot be empty");
			}
			// 失败注入钩子（suites/v4-session-rename.mjs 顺序契约用例消费）：名称以
			// mock-fail 开头时模拟底座失败——供钉住「桥接先原生 set_session_name 后落盘、
			// 原生失败时桥接侧零写入」的顺序契约。其余行为不变。
			if (name.startsWith("mock-fail")) {
				return errorResponse(id, "set_session_name", `Simulated set_session_name failure (mock-fail): ${name}`);
			}
			state.sessionName = name;
			return successResponse(id, "set_session_name");
		}

		case "get_entries": {
			let entries = state.entries;
			if (cmd.since !== undefined) {
				const sinceIndex = entries.findIndex((e) => e.id === cmd.since);
				if (sinceIndex === -1) {
					return errorResponse(id, "get_entries", `Entry not found: ${cmd.since}`);
				}
				entries = entries.slice(sinceIndex + 1);
			}
			return successResponse(id, "get_entries", { entries, leafId: state.entries.at(-1)?.id ?? null });
		}

		case "get_tree": {
			const tree = state.entries.map((entry) => ({ id: entry.id, kind: "message", children: [] }));
			return successResponse(id, "get_tree", { tree, leafId: state.entries.at(-1)?.id ?? null });
		}

		case "get_messages": {
			return successResponse(id, "get_messages", { messages: state.entries.map((e) => e.message) });
		}

		case "get_last_assistant_text": {
			for (let i = state.entries.length - 1; i >= 0; i -= 1) {
				const message = state.entries[i].message;
				if (message?.role === "assistant") {
					const textBlock = (message.content ?? []).find((/** @type {any} */ c) => c?.type === "text");
					if (textBlock) {
						return successResponse(id, "get_last_assistant_text", { text: textBlock.text });
					}
				}
			}
			return successResponse(id, "get_last_assistant_text", { text: null });
		}

		case "get_session_stats": {
			return successResponse(id, "get_session_stats", {
				sessionId: state.sessionId,
				messageCount: state.entries.length,
				totalTokens: 0,
				entryCount: state.entries.length,
			});
		}

		case "bash": {
			const commandText = String(cmd.command ?? "");
			write({ type: "bash_execution_update", delta: `$ ${commandText}\n` });
			write({ type: "bash_execution_update", delta: "mock stdout\n" });
			return successResponse(id, "bash", {
				output: `$ ${commandText}\nmock stdout\n`,
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});
		}

		case "get_commands": {
			return successResponse(id, "get_commands", {
				commands: [
					{
						name: "mock-status",
						description: "Print mock server status",
						source: "extension",
						sourceInfo: { kind: "extension", path: "mock://extensions/mock-status" },
					},
				],
			});
		}

		default: {
			return errorResponse(id, typeof cmd.type === "string" ? cmd.type : String(cmd.type), `Unknown command: ${cmd.type}`);
		}
	}
}
