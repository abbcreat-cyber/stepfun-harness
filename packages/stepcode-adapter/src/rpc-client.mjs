import { mergeDesktopEnvironment, resolveDesktopShellEnvironment } from "./desktop-shell.mjs";
/**
 * StepCodeRpcClient —— `step --mode rpc` 子进程的驱动器。
 *
 * 负责：spawn step 进程、就绪等待（rpc 模式无握手，进程存活即就绪）、
 * 发命令收响应（id 关联 + 超时）、订阅流式增量事件、处理工具批准往返
 * （extension_ui_request → extension_ui_response）、优雅退出与错误传播。
 *
 * 线上协议：stdin/stdout 严格 JSONL（LF-only），形状见 ./rpc-protocol.mjs。
 * 参考官方 Step-Code/packages/coding-agent/src/modes/rpc/rpc-client.ts，
 * 增强：UI 批准往返、EOF 优先的优雅退出、exitError 状态化。
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
 *
 * 壳侧集成（zcodeAgentProcessManager 的 ZCODE_AGENT_SERVER_COMMAND 逃生口）：
 * 适配层门面进程持有本 client，把 ZCode Protocol 的
 * session/create→newSession+setModel、session/send→prompt/steer、
 * session/stop→abort、session/read→getEntries/getTree 映射到本类方法。
 *
 * 方法族拆分（纯机械，见文件尾 Object.assign）：命令包装在 ./rpc-client-commands.mjs、
 * 等待/收集在 ./rpc-client-wait.mjs、扩展 UI 往返在 ./rpc-client-ui.mjs，均挂回本类原型。
 */

import { spawn } from "node:child_process";
import { serializeJsonLine, attachJsonlLineReader } from "./jsonl.mjs";
import { isExtensionUiRequest } from "./rpc-protocol.mjs";
import { rpcCommandMethods } from "./rpc-client-commands.mjs";
import { rpcUiMethods } from "./rpc-client-ui.mjs";
import { rpcWaitMethods } from "./rpc-client-wait.mjs";
import { withDesktopQuestionnaire } from "./desktop-questionnaire.mjs";
import { assertProviderCommunicationLoaded, withProviderCommunication } from "./provider-communication.mjs";
import { assertDesktopAutomationLoaded, withDesktopAutomation } from "./desktop-automation.mjs";
import { withDesktopTaskContracts } from "./desktop-task-contracts.mjs";

/**
 * @typedef {object} StepCodeRpcClientOptions
 * @property {string[]} [command] 显式 spawn 命令（argv 数组，如 [process.execPath, mockPath, "--flag"]）。最高优先。
 * @property {"required"|"mock"} [communicationMode] 默认 required；仅显式 mock backend 可豁免 trusted 扩展，生产 Host 强制 required。
 * @property {string} [nodeExecutable] node 可执行文件（默认 "node"）。与 cliPath 组合使用。
 * @property {string} [cliPath] step CLI 入口（默认官方打包位 "dist/bundle/step.js"，需相对 cwd 或绝对路径）。
 * @property {string[]} [args] 追加到 CLI 的额外参数（--provider/--model/--api-key/--approval-mode 等）。
 * @property {string} [cwd] 子进程工作目录（决定 agent 会话绑定的 workspace）。
 * @property {Record<string, string>} [env] 追加环境变量（STEP_API_KEY / STEPCODE_CONFIG_PATH / STEP_CODING_AGENT_DIR 等）。
 * @property {number} [requestTimeoutMs] 单请求默认超时（默认 30000，对齐官方 rpc-client）。
 * @property {(pid: number) => void | Promise<void>} [onSpawn] 原生进程生成后、trusted 就绪检查前绑定本机工具通道。
 * @property {(req: import("./rpc-protocol.mjs").RpcExtensionUIRequest) => import("./rpc-protocol.mjs").UiResolution | null | undefined | Promise<import("./rpc-protocol.mjs").UiResolution | null | undefined>} [onUiRequest]
 *           扩展 UI 请求处理器。返回 {confirmed}/{value}/{cancelled}；返回 null/undefined 视为 {cancelled:true}（fail-closed）。
 * @property {boolean} [manualUiResponses] true 时不自动回 UI 响应（默认无 handler 时自动回 {cancelled:true}），
 *           留给调用者用 onEvent + respondUiRequest 完全手动驱动往返。
 * @property {(line: string) => void} [onStderrLine] stderr 逐行回调（诊断转发；默认静默收集）。
 */

/** @typedef {{ code: number | null, signal: string | null }} ExitInfo */

/** @typedef {import("./rpc-protocol.mjs").RpcResponse} RpcResponse */
/** @typedef {import("./rpc-protocol.mjs").JsonAgentSessionEvent} JsonAgentSessionEvent */
/** @typedef {import("./rpc-protocol.mjs").RpcExtensionUIRequest} RpcExtensionUIRequest */

const STDERR_CAP_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 1000;

export class StepCodeRpcClient {
	/** @param {StepCodeRpcClientOptions} [options] */
	constructor(options = {}) {
		this.options = options;
		/** @type {import("node:child_process").ChildProcess | null} */
		this.child = null;
		this.spawnPreparation = null;
		/** @type {(() => void) | null} */
		this.stopReadingStdout = null;
		/** @type {Array<(event: JsonAgentSessionEvent) => void>} */
		this.eventListeners = [];
		/** @type {Array<(error: Error) => void>} 等待中的订阅必须随进程失败立即结束。 */
		this.failureListeners = [];
		/** @type {Map<string, { resolve: (r: RpcResponse) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
		this.pendingRequests = new Map();
		/** @type {((req: RpcExtensionUIRequest) => any) | null} */
		this.uiHandler = options.onUiRequest ?? null;
		/** @type {Set<string>} 已响应过的 extension_ui_request id（幂等防重） */
		this.respondedUiIds = new Set();
		this.requestSeq = 0;
		this.stderrText = "";
		/** @type {Error | null} */
		this.exitError = null;
		/** @type {ExitInfo | null} */
		this.exitInfo = null;
		/** @type {Array<(info: ExitInfo) => void>} */
		this.exitWaiters = [];
	}

	// =========================================================================
	// 生命周期
	// =========================================================================

	/** 解析 spawn argv。 */
	resolveSpawnCommand() {
		if (this.options.command) {
			const command = withDesktopTaskContracts(withDesktopAutomation(withProviderCommunication(withDesktopQuestionnaire(this.options.command), this.options), this.options), this.options);
			return { command: command[0], args: command.slice(1) };
		}
		const node = this.options.nodeExecutable ?? "node";
		const cliPath = this.options.cliPath ?? "dist/bundle/step.js";
		const command = withDesktopTaskContracts(withDesktopAutomation(withProviderCommunication(withDesktopQuestionnaire([node, cliPath, "--mode", "rpc", ...(this.options.args ?? [])]), this.options), this.options), this.options);
		return { command: command[0], args: command.slice(1) };
	}

	/**
	 * 启动 step 进程。rpc 模式无握手帧：进程 spawn 成功且未立刻退出即视为就绪。
	 * @returns {Promise<void>} spawn 失败（ENOENT 等）或启动即退出时 reject。
	 */
	async start() {
		if (this.child || this.spawnPreparation) {
			throw new Error("Client already started");
		}
		this.exitError = null;
		this.exitInfo = null;

		const { command, args } = this.resolveSpawnCommand();
		// 异步查安装路径期间仍只允许一个启动；stop 必须等待这一步，不能在停止后迟到地生成进程。
		this.spawnPreparation = resolveDesktopShellEnvironment(mergeDesktopEnvironment(process.env, this.options.env));
		let shell;
		try { shell = await this.spawnPreparation; }
		finally { this.spawnPreparation = null; }
		/** @type {import("node:child_process").ChildProcess} */
		const child = spawn(command, args, {
			cwd: this.options.cwd,
			env: shell.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;

		// 收集 stderr（限量），可逐行转发给宿主诊断通道。
		let stderrBuffer = "";
		child.stderr?.on("data", (/** @type {Buffer} */ chunk) => {
			const text = chunk.toString();
			if (this.stderrText.length < STDERR_CAP_BYTES) {
				this.stderrText += text;
			}
			if (this.options.onStderrLine) {
				stderrBuffer += text;
				let newlineIndex = stderrBuffer.indexOf("\n");
				while (newlineIndex !== -1) {
					const line = stderrBuffer.slice(0, newlineIndex).replace(/\r$/, "");
					this.options.onStderrLine?.(line);
					stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
					newlineIndex = stderrBuffer.indexOf("\n");
				}
			}
		});

		const attachExitError = (/** @type {Error} */ error) => {
			if (this.child !== child) return;
			this.fail(error);
		};

		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.exitInfo = { code, signal };
			attachExitError(new Error(`step process exited (code=${code} signal=${signal}). Stderr: ${this.stderrTail()}`));
			this.flushExitWaiters();
		});
		child.once("error", (error) => {
			if (this.child !== child) return;
			attachExitError(new Error(`step process error: ${error.message}. Stderr: ${this.stderrTail()}`));
			// spawn 失败（如 ENOENT）只发 'error' 不发 'exit'：进程已不存在，按无退出码处理。
			if (!this.exitInfo) {
				this.exitInfo = { code: null, signal: null };
			}
			this.flushExitWaiters();
		});
		child.stdin?.on("error", (error) => {
			if (this.child !== child) return;
			// stdin 断流多半是进程先行退出；保留首个（更根本的）错误。
			attachExitError(new Error(`step process stdin error: ${error.message}. Stderr: ${this.stderrTail()}`));
		});

		this.stopReadingStdout = attachJsonlLineReader(child.stdout ?? null, (line) => {
			this.handleLine(line);
		});

		// 等 spawn 成功（或失败/立刻退出）。
		await new Promise((resolve, reject) => {
			const onSpawn = () => done(undefined);
			const onError = (/** @type {Error} */ error) => done(new Error(`Failed to spawn step process: ${error.message}`));
			const onExit = (/** @type {number | null} */ code, /** @type {string | null} */ signal) =>
				done(new Error(`step process exited during startup (code=${code} signal=${signal}). Stderr: ${this.stderrTail()}`));
			/** @param {undefined | Error} outcome */
			const done = (outcome) => {
				child.off("spawn", onSpawn);
				child.off("error", onError);
				child.off("exit", onExit);
				if (outcome) {
					reject(outcome);
				} else {
					resolve(undefined);
				}
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
			child.once("exit", onExit);
		});
		try {
			// MCP 初始化会读取 PID relay；等 trusted 就绪后才绑定会形成启动等待环。
			await this.options.onSpawn?.(child.pid);
			await assertProviderCommunicationLoaded(this);
			await assertDesktopAutomationLoaded(this);
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	/**
	 * 优雅停止：先关 stdin（EOF → agent flush 后 exit 0），超时退化为 SIGTERM，再退化为 SIGKILL。
	 * 幂等：已停止/未启动时直接返回已知退出信息。
	 * @param {{ timeoutMs?: number }} [options]
	 * @returns {Promise<ExitInfo>}
	 */
	async stop({ timeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
		if (this.spawnPreparation) await this.spawnPreparation.catch(() => {});
		const child = this.child;
		if (!child) {
			return this.exitInfo ?? { code: null, signal: null };
		}

		try {
			child.stdin?.end();
		} catch {
			// stdin 已断；走 kill 兜底。
		}

		if (!this.exitInfo) {
			try {
				await this.waitForExit(timeoutMs);
			} catch {
				// 超时：SIGTERM。
			}
		}
		if (!this.exitInfo) {
			try {
				child.kill("SIGTERM");
			} catch {
				// 进程可能刚好退出。
			}
			try {
				await this.waitForExit(KILL_GRACE_MS);
			} catch {
				// 仍超时：SIGKILL。
			}
		}
		if (!this.exitInfo) {
			try {
				child.kill("SIGKILL");
			} catch {
				// 忽略；waitForExit 的兜底超时仍保证返回。
			}
			try {
				await this.waitForExit(KILL_GRACE_MS);
			} catch {
				// 无法收集退出信息（极端：进程无法杀死）。保留 null 返回。
			}
		}

		this.teardown();
		return this.exitInfo ?? { code: null, signal: null };
	}

	/** 卸载 reader、reject 挂起请求、丢弃 child 引用。 */
	teardown() {
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.fail(new Error("Client stopped"));
		this.child = null;
	}

	/** @returns {boolean} 进程是否仍在运行。 */
	isRunning() {
		return this.child !== null && this.exitInfo === null;
	}

	/**
	 * 等待进程退出。已退出时立即返回。
	 * @param {number} [timeoutMs] 超时 reject（默认无限等）。
	 * @returns {Promise<ExitInfo>}
	 */
	waitForExit(timeoutMs) {
		if (this.exitInfo) {
			return Promise.resolve(this.exitInfo);
		}
		return new Promise((resolve, reject) => {
			/** @type {NodeJS.Timeout | undefined} */
			let timer;
			const waiter = (info) => {
				if (timer) clearTimeout(timer);
				const index = this.exitWaiters.indexOf(waiter);
				if (index !== -1) this.exitWaiters.splice(index, 1);
				resolve(info);
			};
			this.exitWaiters.push(waiter);
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					const index = this.exitWaiters.indexOf(waiter);
					if (index !== -1) this.exitWaiters.splice(index, 1);
					reject(new Error(`Timeout waiting for step process exit after ${timeoutMs}ms`));
				}, timeoutMs);
			}
		});
	}

	/** @private */
	flushExitWaiters() {
		const info = this.exitInfo ?? { code: null, signal: null };
		const waiters = this.exitWaiters.splice(0);
		for (const waiter of waiters) {
			waiter(info);
		}
	}

	// =========================================================================
	// 订阅
	// =========================================================================

	/**
	 * 订阅事件流（流式增量 message_update、tool_execution_*、agent_settled、
	 * extension_ui_request、无 id 的响应行——与官方 RpcClient 一致全部广播）。
	 * @param {(event: JsonAgentSessionEvent) => void} listener
	 * @returns {() => void} 退订函数
	 */
	onEvent(listener) {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/** 生命周期失败与业务事件分开，不能伪造 agent_settled 或成功终态。 */
	onFailure(listener) {
		if (this.exitError) { listener(this.exitError); return () => {}; }
		this.failureListeners.push(listener);
		return () => {
			const index = this.failureListeners.indexOf(listener);
			if (index !== -1) this.failureListeners.splice(index, 1);
		};
	}

	/** @private @param {Error} error */
	fail(error) {
		this.exitError ??= error;
		this.rejectAllPending(this.exitError);
		// 回调会退订自己，必须遍历快照，不能跳过相邻等待者。
		for (const listener of this.failureListeners.slice()) {
			try { listener(this.exitError); } catch { /* 与事件监听相同，单个异常不阻断其他等待。 */ }
		}
	}

	/** 累计的 stderr（上限 256KB），排查子进程问题用。 */
	getStderr() {
		return this.stderrText;
	}

	/** @private */
	stderrTail() {
		const tailLength = 2000;
		return this.stderrText.length > tailLength
			? `…${this.stderrText.slice(-tailLength)}`
			: this.stderrText;
	}

	// =========================================================================
	// 命令
	// =========================================================================

	/**
	 * 发送任意命令并等待响应（低层 API）。
	 * @param {Record<string, any> & { id?: string, type: string }} command
	 * @param {{ timeoutMs?: number }} [options]
	 * @returns {Promise<RpcResponse>}
	 */
	async request(command, options = {}) {
		const child = this.child;
		const stdin = child?.stdin;
		if (!child || !stdin) {
			throw new Error("Client not started");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (child.exitCode !== null) {
			this.exitError = this.exitError ?? new Error(`step process exited (code=${child.exitCode} signal=${child.signalCode}). Stderr: ${this.stderrTail()}`);
			throw this.exitError;
		}
		if (stdin.destroyed || !stdin.writable) {
			this.exitError = new Error(`step process stdin is not writable. Stderr: ${this.stderrTail()}`);
			throw this.exitError;
		}

		const id = command.id ?? `req_${++this.requestSeq}`;
		const fullCommand = { ...command, id };
		const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				// stepTimeout=true：投递状态未知（响应可能迟到/进程可能仍在处理），
				// 上层（桥接台账）据此决定「不清理不重发」。机器可读属性，不做文本匹配。
				reject(Object.assign(new Error(`Timeout waiting for response to ${command.type} (${timeoutMs}ms). Stderr: ${this.stderrTail()}`), { stepTimeout: true }));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timer);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
				timer,
			});

			try {
				stdin.write(serializeJsonLine(fullCommand));
			} catch (error) {
				this.pendingRequests.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/**
	 * 写任意原始行（测试/诊断用；帧化责任在调用方）。
	 * @param {string} line
	 */
	writeRawLine(line) {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new Error("Client not started");
		}
		stdin.write(line.endsWith("\n") ? line : `${line}\n`);
	}

	/**
	 * 取响应 data；失败响应抛 Error（对齐官方 getData）。
	 * @protected
	 * @param {RpcResponse} response
	 * @returns {any}
	 */
	getData(response) {
		if (!response.success) {
			throw new Error(response.error ?? `${response.command} failed`);
		}
		return response.data;
	}

	/** @param {RpcResponse} response @returns {Promise<void>} */
	async expectSuccess(response) {
		if (!response.success) {
			throw new Error(response.error ?? `${response.command} failed`);
		}
	}

	// =========================================================================
	// 内部：行分发
	// =========================================================================

	/** @private @param {string} line */
	handleLine(line) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			// 非 JSON 行忽略（对齐官方 handleLine）。
			return;
		}
		if (typeof parsed !== "object" || parsed === null) {
			return;
		}

		// 1) 挂起请求的响应：id 匹配才消费。
		if (parsed.type === "response" && typeof parsed.id === "string" && this.pendingRequests.has(parsed.id)) {
			const pending = this.pendingRequests.get(parsed.id);
			this.pendingRequests.delete(parsed.id);
			pending.resolve(parsed);
			return;
		}

		// 2) 扩展 UI 请求：广播给事件流（官方行为），并在注册了 handler 时驱动批准往返。
		if (isExtensionUiRequest(parsed)) {
			this.dispatchUiRequest(parsed);
			// 继续落入广播。
		}

		// 3) 其余一律按事件广播（含无 id 的响应行，如 command:"parse" 的错误）。
		for (const listener of [...this.eventListeners]) {
			try {
				listener(parsed);
			} catch {
				// 监听器异常不阻断分发。
			}
		}
	}

	/** @private @param {Error} error */
	rejectAllPending(error) {
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}

// 方法族拆分（纯机械）：命令包装（prompt…bash）、等待/收集（waitForIdle/collectEvents）、
// 扩展 UI 往返（handleUiRequests/respondUiRequest/dispatchUiRequest）按族抽到同目录
// rpc-client-commands.mjs / rpc-client-wait.mjs / rpc-client-ui.mjs，挂回原型后仍是
// StepCodeRpcClient 的实例方法，公共接口与行为不变。
Object.assign(StepCodeRpcClient.prototype, rpcCommandMethods, rpcWaitMethods, rpcUiMethods);
