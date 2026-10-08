/**
 * bridge-log-file 套件（R3 评审 medium ② 修复：准入决策日志的生产取证通道）。
 *
 * 验收点（docs/step-input-admission-queue-spec.md §10）：
 * 1. argv `--log-file`（与 --state-dir 同构，spec §8 的确定性 argv 通道）下发后，
 *    桥进程的 admission 决策行（branch=direct/queue/steer/reject）与启动行
 *    best-effort 追加落盘——生产态 host 不转发 bridge stderr（app.log 全程无
 *    bridge 日志），取证只能靠该文件。E2E 走默认路由入口，顺带覆盖
 *    session-router 对 --log-file 的 argv 透传（worker 才是准入日志的产出者）。
 * 2. logging.mjs 体积上限：文件超 5MB 时写入前截断重写（保留尾部一半、按行边界
 *    对齐、落截断标记行），长期运行不会无限增长。
 * 3. setBridgeLogFilePath 空白/null 恢复不落盘：argv 未传 --log-file 时行为与
 *    历史逐字节一致（只走 stderr，零落盘）。
 * 4. 仅设 env、不传 argv 仍落盘（R4 评审 medium 回归修复）：通道优先序为
 *    显式 argv > env > 缺省不落盘（spec §10）——首版 bin 无条件以 null 覆盖，
 *    把 env 初值清零致 env 通道静默失效，本条防该回归。
 *
 * 单元用例直接改 logging.mjs 的模块级状态——test/index.js 聚合加载所有套件于
 * 同一进程，每个用例必须在 finally 里 setBridgeLogFilePath(null) 恢复。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBridge } from "./helpers.mjs";
import { log, setBridgeLogFilePath } from "../src/bridge/logging.mjs";

/** 与 src/bridge/logging.mjs 的 LOG_FILE_MAX_BYTES 保持一致（超限截断阈值）。 */
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** 轮询等待日志文件出现包含 substring 的行（写盘与测试读取之间是异步时序）。 */
function waitForFileLine(path, substring, { timeoutMs = 10000 } = {}) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			let content = "";
			try {
				content = readFileSync(path, "utf8");
			} catch {
				// 文件尚未创建（首行写入前的窗口），继续轮询。
			}
			if (content.includes(substring)) {
				clearInterval(timer);
				resolve(content);
			} else if (Date.now() - startedAt > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`timeout waiting for log file line: ${substring}; file tail=${content.slice(-800)}`));
			}
		}, 25);
	});
}

test("--log-file argv：admission 决策行与启动行落文件（经路由透传到 session worker）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "stepbridge-logfile-"));
	const logFile = join(dir, "bridge.log");
	const b = launchBridge(["--log-file", logFile]);
	// 日志目录归本用例所有：等桥退出后再删（Windows 句柄延迟释放时 force + 忽略失败，
	// 临时目录兜底由系统清理）。
	b.child.once("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 同 helpers.mjs 的既有口径。
		}
	});
	try {
		// createSession firstInput 走 admitAndSend 的 direct 分支（新会话 idle 恒 prompt）。
		b.send({
			id: 1,
			method: "v4/command",
			params: {
				commandId: "lf-create",
				sessionId: "lf-1",
				type: "createSession",
				payload: { firstInput: { text: "取证直发" }, workspaceId: "ws" },
			},
		});
		await b.waitFor((f) => f.id === 1, { label: "createSession lf-1" });
		const content = await waitForFileLine(logFile, "admission branch=direct commandId=lf-create delivery=startNow");
		assert.match(content, /started \(pid=\d+\)/, "进程启动行必须与准入行同文件落盘");
	} finally {
		b.child.kill();
	}
});

test("仅设 env、不传 argv 仍落盘（R4 回归：argv 缺省不得清零 env 初值）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "stepbridge-logenv-"));
	const logFile = join(dir, "bridge.log");
	// env 键名运行时拼接（helpers.mjs 先例 + spec §8）：宿主对 STECODE_* 前缀及其
	// 源码字面量存在间歇性清洗，不在源码中写该字面量。
	const logEnvKey = ["STECODE", "BRIDGE", "LOG", "FILE"].join("_");
	// 不传 --log-file argv，只走 env 通道（与上一用例的 argv 通道对称）。经默认
	// 路由入口：session-router spawn worker 时 spread process.env，worker 的
	// logging.mjs 模块加载读 env 初值落盘——同时覆盖路由对 env 的透传。
	// 修复前 bin 无条件 setBridgeLogFilePath(null) 清零 env 初值，本用例在其
	// 版本上必失败（waitForFileLine 超时），守护该回归。
	const b = launchBridge([], { [logEnvKey]: logFile });
	b.child.once("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 同 helpers.mjs 的既有口径。
		}
	});
	try {
		b.send({
			id: 1,
			method: "v4/command",
			params: {
				commandId: "lfenv-create",
				sessionId: "lfenv-1",
				type: "createSession",
				payload: { firstInput: { text: "取证 env 回退" }, workspaceId: "ws" },
			},
		});
		await b.waitFor((f) => f.id === 1, { label: "createSession lfenv-1" });
		const content = await waitForFileLine(logFile, "admission branch=direct commandId=lfenv-create delivery=startNow");
		assert.match(content, /started \(pid=\d+\)/, "进程启动行也必须经 env 初值同文件落盘");
	} finally {
		b.child.kill();
	}
});

test("logging 体积上限：超 5MB 的日志文件在写入前截断重写（保留尾部一半、按行对齐）", () => {
	const dir = mkdtempSync(join(tmpdir(), "stepbridge-logunit-"));
	const logFile = join(dir, "bridge.log");
	const fillerLine = `${"x".repeat(120)}\n`;
	const fillerRepeat = Math.ceil((LOG_FILE_MAX_BYTES + 8192) / fillerLine.length);
	writeFileSync(logFile, fillerLine.repeat(fillerRepeat), "utf8");
	const before = statSync(logFile).size;
	assert.ok(before > LOG_FILE_MAX_BYTES, `预置文件必须超限（before=${before}）`);
	try {
		setBridgeLogFilePath(logFile);
		log("truncation probe");
		const after = statSync(logFile).size;
		assert.ok(after < before, `截断重写后必须小于写前体积（after=${after}, before=${before}）`);
		assert.ok(after <= LOG_FILE_MAX_BYTES, `截断后应回到上限以内（after=${after}）`);
		const content = readFileSync(logFile, "utf8");
		assert.ok(content.startsWith("[Step Code bridge] [log truncated at "), "首行必须是截断标记（前半内容已丢弃）");
		assert.match(content, /truncation probe/, "截断后新行照常追加到尾部");
		const lineCount = content.split("\n").filter((line) => line.length > 0).length;
		assert.ok(lineCount < fillerRepeat * 0.6, `保留行数应约为原一半（lines=${lineCount}, before lines=${fillerRepeat}）`);
		assert.ok(content.endsWith("truncation probe\n"), "尾行是本次写入");
	} finally {
		setBridgeLogFilePath(null);
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 同上：临时目录兜底由系统清理。
		}
	}
});

test("setBridgeLogFilePath：空白路径不开启、null 恢复关闭（argv 未传 --log-file 时零落盘）", () => {
	const dir = mkdtempSync(join(tmpdir(), "stepbridge-logoff-"));
	const logFile = join(dir, "bridge.log");
	try {
		setBridgeLogFilePath("   ");
		setBridgeLogFilePath(logFile);
		log("line one");
		assert.ok(readFileSync(logFile, "utf8").includes("line one"), "注入路径后首行必须落盘");
		setBridgeLogFilePath(null);
		log("line two must not persist");
		assert.equal(readFileSync(logFile, "utf8").includes("line two"), false, "恢复 null 后不得再写文件（只走 stderr）");
	} finally {
		setBridgeLogFilePath(null);
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 同上。
		}
	}
});
