#!/usr/bin/env node
/**
 * step-rpc-mock —— 忠实复刻 `step --mode rpc` stdio JSONL 协议的 mock 服务器。
 *
 * 本文件是入口（参数解析 + stdin 循环 + 信号语义）；实现按原分节机械拆分在同目录：
 * mock-io（输出原语）/ mock-config（delay/hang 配置）/ mock-state（会话状态）/
 * mock-runtime（RunCancelled/可取消 sleep/当前运行句柄）/ mock-messages（消息构造）/
 * mock-extension-ui（confirm 往返）/ mock-scenarios（剧本）/ mock-prompt-queue
 * （prompt 队列与两池 drain）/ mock-commands（命令分发）。
 *
 * 行为依据（Step-Code 源码）：
 * - rpc-mode.ts:54-817：无握手，stdin 即命令通道；stdout 只写协议行（诊断一律 stderr）；
 *   stdin EOF → flush 后 exit 0；SIGINT/SIGTERM → 130/143；非法 JSON 行 → command:"parse" 错误响应。
 * - rpc-mode.ts:399-421：prompt 响应在 preflight 成功后异步发出（先于事件流）。
 * - json-event.ts:20-61：message_update 剥掉 partial；toolcall_start 附加 id/toolName。
 * - agent-core/types.ts:452-467 + agent-session.ts:125-177：事件类型全集。
 * - rpc-mode.ts:91-131：extension_ui_request 带 timeout 时超时按默认值 resolve（confirm 默认 false）。
 *
 * 剧本路由（prompt message）：
 * - "mock:tool"           工具调用流（toolcall_start/delta/end + tool_execution_start/update/end）
 * - "mock:confirm"        工具批准往返：发 extension_ui_request(confirm)，等 extension_ui_response；
 *                         等待期间持续发 bash_execution_update（验证"批准期间事件流不断"）
 * - "mock:confirm-timeout" 同上但请求带 timeout:250，超时按拒绝（false）继续
 * - "mock:input"          input 追问往返：发 extension_ui_request(input)，等响应——
 *                         cancelled 或无 string value 均得 undefined（rpc-mode.ts:147-153）
 * - "mock:select"         select 追问往返：发 extension_ui_request(select)（options 数组），
 *                         语义同 mock:input
 * - "mock:error"          prompt preflight 失败（回 success:false 的 prompt 响应）
 * - "mock:crash"          模拟崩溃：直接 process.exit(1)（不发 prompt 响应）
 * - "mock:exit130"        回 prompt success 后 process.exit(130)（模拟 SIGINT）
 * - 其它（含 "hi"）       文本问答：user/assistant 消息对 + text_start/delta×N/end 流式增量
 *
 * CLI 参数：
 *   --hang <commandType>   收到该类型命令后不回响应（测客户端超时/进程退出时的 pending reject）
 *   --ignore-eof           stdin EOF 后不退出（测客户端 kill 兜底）
 *   --delay <ms>           事件间延迟（默认 2；0 = 全速）
 * 环境变量：STEP_MOCK_DELAY_MS 同 --delay；STEP_MOCK_PROMPT_ERROR 覆盖 "mock:error"
 *           剧本的 prompt 失败原文（供 bridge 错误归类测试模拟各类云端/CLI 失败文案）。
 *           STEP_MOCK_HANG_COMMAND 同 --hang，仅此 mock 入口读取，CLI 参数仍优先。
 *
 * 用法：node step-rpc-mock.mjs [--hang get_state] [--ignore-eof] [--delay 2]
 *
 * 本文件及其拆分模块派生自 stepfun-ai/Step-Code（https://github.com/stepfun-ai/Step-Code，
 * packages/coding-agent/src/modes/rpc-mode.ts 及 rpc/ 下的 jsonl/rpc-types/rpc-client），
 * 依其 MIT License 授权，原版权与许可声明随各文件保留：
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

import { attachJsonlLineReader } from "../src/jsonl.mjs";
import { errorResponse, isExtensionUiResponse } from "../src/rpc-protocol.mjs";
import { write, diag } from "./mock-io.mjs";
import { mockConfig } from "./mock-config.mjs";
import { pendingExtensionRequests } from "./mock-extension-ui.mjs";
import { handleCommand } from "./mock-commands.mjs";

// --- 参数解析 ---------------------------------------------------------------

const rawArgs = process.argv.slice(2);
let ignoreEof = false;
// 内建 mock 的挂起夹具沿自身配置注入，不为真实/未知 CLI 豁免 trusted 通信组件。
mockConfig.hangCommand = process.env.STEP_MOCK_HANG_COMMAND?.trim() || null;
for (let i = 0; i < rawArgs.length; i += 1) {
	if (rawArgs[i] === "--hang" && rawArgs[i + 1] !== undefined) {
		mockConfig.hangCommand = rawArgs[i + 1];
		i += 1;
	} else if (rawArgs[i] === "--ignore-eof") {
		ignoreEof = true;
	} else if (rawArgs[i] === "--delay" && rawArgs[i + 1] !== undefined) {
		mockConfig.delayMs = Number(rawArgs[i + 1]);
		i += 1;
	}
}

// --- stdin 循环（rpc-mode.ts:748-813 的忠实复刻） ------------------------------

/** @param {string} line */
async function handleInputLine(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch (parseError) {
		write(
			errorResponse(
				undefined,
				"parse",
				`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
			),
		);
		return;
	}

	// extension_ui_response 先于命令分发（rpc-mode.ts:764-778）。
	if (isExtensionUiResponse(parsed)) {
		const resolver = pendingExtensionRequests.get(parsed.id);
		if (resolver) {
			pendingExtensionRequests.delete(parsed.id);
			resolver(parsed);
		}
		return;
	}

	try {
		const response = await handleCommand(parsed);
		if (response) {
			write(response);
		}
	} catch (commandError) {
		write(
			errorResponse(
				parsed?.id,
				typeof parsed?.type === "string" ? parsed.type : "unknown",
				commandError instanceof Error ? commandError.message : String(commandError),
			),
		);
	}
}

process.stdin.on("end", () => {
	if (ignoreEof) {
		diag("stdin EOF ignored (--ignore-eof)");
		return;
	}
	diag("stdin EOF -> exit 0");
	process.exit(0);
});

attachJsonlLineReader(process.stdin, (line) => {
	void handleInputLine(line);
});

// 信号语义对齐 rpc-mode.ts:371-385（win32 无 SIGHUP）。
process.on("SIGINT", () => {
	diag("SIGINT -> exit 130");
	process.exit(130);
});
process.on("SIGTERM", () => {
	diag("SIGTERM -> exit 143");
	process.exit(143);
});

diag(
	`ready (delay=${mockConfig.delayMs}ms${mockConfig.hangCommand ? ` hang=${mockConfig.hangCommand}` : ""}${ignoreEof ? " ignoreEof" : ""}); ` +
		`first command may be sent immediately (no handshake in rpc mode)`,
);

// 常驻（rpc-mode.ts:816 return new Promise(() => {})）。
setInterval(() => {}, 1 << 30);
