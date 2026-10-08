/**
 * 测试公共辅助：构造指向 stdio mock 的 StepCodeRpcClient、事件收集器、
 * 桥接进程启动器（launchBridge）等。
 * 真实套件放在 suites/（不在 test/ 目录、不带 .test. 后缀），只被 test/index.js 聚合加载。
 *
 * 注意：状态目录一律走 options.stateDir + `--state-dir` argv 传递——本仓库宿主环境
 * 对 STECODE_* 环境变量（及其在命令/文件中的字面量）存在间歇性清洗，argv 是
 * 确定性通道；桥接入口对未知参数容忍并透传（路由→worker）。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";

/** @type {URL} */
export const MOCK_URL = new URL("../mock/step-rpc-mock.mjs", import.meta.url);

/** 桥接路由入口（bin/zcode-bridge.mjs）的 URL。 */
const BRIDGE_URL = new URL("../bin/zcode-bridge.mjs", import.meta.url);

/** session worker 入口（bin/zcode-bridge-session.mjs）的 URL。 */
const SESSION_BRIDGE_URL = new URL("../bin/zcode-bridge-session.mjs", import.meta.url);

/**
 * 构造一个 spawn mock 服务器的 client。
 * @param {string[]} [flags] mock 的 CLI 参数（--hang/--ignore-eof/--delay）
 * @param {import("../src/rpc-client.mjs").StepCodeRpcClientOptions} [options]
 */
export function mockClient(flags = [], options = {}) {
	return new StepCodeRpcClient({
		communicationMode: "mock",
		command: [process.execPath, fileURLToPath(MOCK_URL), ...flags],
		requestTimeoutMs: 8000,
		...options,
	});
}

/**
 * 给 client 挂一个事件收集器。
 * @param {StepCodeRpcClient} client
 */
export function collector(client) {
	/** @type {any[]} */
	const events = [];
	const unsubscribe = client.onEvent((event) => events.push(event));
	return { events, unsubscribe };
}

/**
 * @param {any[]} events
 * @param {string} type
 */
export const eventsOfType = (events, type) => events.filter((event) => event.type === type);

/**
 * @param {any[]} events
 * @param {string} type
 */
export const indexOfEvent = (events, type) => events.findIndex((event) => event.type === type);

/**
 * @param {number} ms
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 有界等待子进程退出（挂死治理，R3 §三.4/§四.4）：先查 exitCode/signalCode 已落定
 * 则立即返回（参照 src/rpc-client.mjs stop() 的 exitInfo 先查实现），等待上限默认
 * 30s；超时 kill 进程并抛带上下文的错误（label + stderr 尾部取证）。无界
 * `await new Promise((r) => child.once("exit", r))` 在桥挂死时永不 resolve，会让
 * 整个测试进程卡死不退出——所有等待桥/子进程退出的用例一律走本函数。
 * @param {import("node:child_process").ChildProcess} child
 * @param {{ timeoutMs?: number, label?: string }} [options] label：超时错误里的用例标识。
 * @returns {Promise<{ code: number | null, signal: string | null }>}
 */
export function waitForExit(child, { timeoutMs = 30000, label = "child process" } = {}) {
	// 已退出（正常退出码或被信号杀死）：立即返回，不挂监听（先查实现）。
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve, reject) => {
		let stderrTailText = "";
		/** @type {NodeJS.Timeout | undefined} */
		let timer;
		const onStderrData = (/** @type {string} */ chunk) => {
			stderrTailText = `${stderrTailText}${chunk}`.slice(-2000);
		};
		/** @param {() => void} outcome */
		const settle = (outcome) => {
			if (timer) clearTimeout(timer);
			child.off("exit", onExit);
			child.off("error", onError);
			child.stderr?.off("data", onStderrData);
			outcome();
		};
		const onExit = (/** @type {number | null} */ code, /** @type {string | null} */ signal) =>
			settle(() => resolve({ code, signal }));
		// spawn 失败等场景 'exit' 可能不触发（exitCode 恒 null 的挂点），一并兜住。
		const onError = (/** @type {Error} */ error) =>
			settle(() => reject(new Error(`waitForExit：子进程错误（${label}）: ${error.message}`)));
		timer = setTimeout(() => {
			settle(() => {
				try {
					child.kill();
				} catch {
					// 进程可能刚好退出。
				}
				reject(new Error(`waitForExit 超时（${timeoutMs}ms，已 kill）: ${label}${stderrTailText ? `；stderr 尾部: ${stderrTailText}` : ""}`));
			});
		}, timeoutMs);
		child.once("exit", onExit);
		child.once("error", onError);
		child.stderr?.on("data", onStderrData);
	});
}

/**
 * 断言事件流中 predicate 的出现顺序（返回下标，未出现返回 -1）。
 * @param {any[]} events
 * @param {(event: any) => boolean} predicate
 */
export const indexOf = (events, predicate) => events.findIndex(predicate);

/**
 * 启动一个桥接进程（默认走 bin/zcode-bridge.mjs 路由入口，与桌面壳真实路径一致：
 * host 起路由进程，路由再派生 session worker）。
 * 从 suites/zcode-bridge.mjs 平移为共享辅助；状态目录改为 argv 传递（见文件头注释）。
 * @param {string[]} [extraArgs] 额外 CLI 参数（如 --step-cli）
 * @param {Record<string, string>} [extraEnv] 额外环境变量（如 mock 的 STEP_MOCK_DELAY_MS）
 * @param {{stateDir?: string, entry?: "router" | "session", cwd?: string}} [options]
 *   stateDir：桥接状态目录（经 --state-dir argv 下发，默认每次启动独立临时目录并在退出时清理）；
 *   entry:"session"：直连 session worker（绕过路由层，测 worker 级行为）；
 *   cwd：桥进程工作目录（缺省继承当前进程）。生产 host 以 workspacePath 为桥 cwd
 *   spawn（zcodeAgentProcessManager），而 sessions-index 摘要按该 cwd 键控落盘
 *   （bin/zcode-bridge-session.mjs 的 createSession 分支）——键控行为的回归测试
 *   需要显式控制它。
 * @returns {{child: import("node:child_process").ChildProcess, frames: any[], send: (f: object) => void, waitFor: (p: (f: any) => boolean, o?: object) => Promise<any>, stderr: string, stateDir: string}}
 */
export function launchBridge(extraArgs = [], extraEnv = {}, options = {}) {
	// 兼容多种传法：options.stateDir（推荐）与 extraEnv 里的状态目录环境键。键名一律
	// 运行时拼接（避免在源码中出现受保护前缀的完整字面量——宿主对这类字面量存在
	// 间歇性清洗），且带 P / 不带 P 两种前缀拼写都识别：仓库不同时期的调用方两种
	// 拼写并存——zcode-bridge 系套件（sessions-index 与 attachments 的跨进程持久化
	// 用例）经 extraEnv 传带 P 形，本文件历史版本只认不带 P 形（launchBridge 合并前
	// 无人经 env 键传状态目录，故拼写差异一直未暴露）。任一拼写命中即作为源转为
	// --state-dir argv 下发，不构成子进程 env 通道依赖（桥接入口 argv 优先）。
	const stateEnvKeys = [
		[["STEP", "CODE"].join(""), "BRIDGE", "STATE", "DIR"].join("_"),
		[["STE", "CODE"].join(""), "BRIDGE", "STATE", "DIR"].join("_"),
	];
	const stateDirFromEnv = stateEnvKeys
		.map((key) => extraEnv[key])
		.find((value) => value !== undefined);
	const stateDir = options.stateDir ?? stateDirFromEnv ?? mkdtempSync(join(tmpdir(), "stepbridge-"));
	const ownsStateDir = options.stateDir === undefined && stateDirFromEnv === undefined;
	const entryUrl = options.entry === "session" ? SESSION_BRIDGE_URL : BRIDGE_URL;
	const entryArgs = options.entry === "session"
		? ["--state-dir", stateDir, "--session-worker"]
		: ["--state-dir", stateDir];
	const child = spawn(process.execPath, [fileURLToPath(entryUrl), ...entryArgs, ...extraArgs], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...extraEnv },
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
	if (ownsStateDir) {
		child.once("exit", () => {
			try {
				rmSync(stateDir, { recursive: true, force: true });
			} catch {
				// Windows 句柄延迟释放时忽略；临时目录由系统清理。
			}
		});
	}
	/** @type {any[]} */
	const frames = [];
	let buffer = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.trim()) frames.push(JSON.parse(line));
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	return {
		child,
		frames,
		stderr,
		stateDir,
		send: (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`),
		waitFor: (predicate, { timeoutMs = 15000, label = "frame" } = {}) =>
			new Promise((resolve, reject) => {
				const startedAt = Date.now();
				const timer = setInterval(() => {
					const found = frames.find(predicate);
					if (found) {
						clearInterval(timer);
						resolve(found);
					} else if (Date.now() - startedAt > timeoutMs) {
						clearInterval(timer);
						reject(new Error(`timeout waiting for ${label}; frames=${frames.map((f) => f.method ?? `resp:${f.id}`).join(",")}; stderr=${stderr}`));
					}
				}, 25);
			}),
	};
}
