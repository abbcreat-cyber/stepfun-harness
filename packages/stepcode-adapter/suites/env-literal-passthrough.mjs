/**
 * env-literal-passthrough 套件（R6 字面量清除轮：env 键运行时拼接的 env-only 回归）。
 *
 * 背景（R5 评审 low + 补复测 3/3 复现）：宿主对源码中受保护前缀的连续字面量存在
 * 「两套视图」间歇清洗——readFileSync 读回完好，但 node 执行层对字面量键的 env 属性
 * 访问间歇读不到。本轮修复（同 src/bridge/logging.mjs 的 BRIDGE_LOG_FILE_ENV_KEY
 * 先例 + spec §8）：
 *   - bin/zcode-bridge-session.mjs：STEPCODE_BRIDGE_STATE_DIR /
 *     STEPCODE_SESSION_WORKER / STECODE_STORAGE_ROOT_DIR 三处读键改运行时拼接；
 *   - src/session-router.mjs：spawn worker 时 STEPCODE_SESSION_WORKER 写键改运行时拼接。
 * （注：本仓受保护前缀有带 P / 不带 P 两种历史拼写并存，见 helpers.mjs 的
 * stateEnvKeys 兼容逻辑；上述四处实际键名均带 P，拼接部件保持同值，行为不变。）
 *
 * 本套件对每个键补一条 env-only 回归（同 bridge-log-file.mjs 用例 2 的写法：测试侧
 * 键名也运行时拼接、不传对应 argv，证明 env 通道独立成立——字面量若回归且命中清洗，
 * 用例在轮询处超时失败，不会静默落默认目录）。三条的观测面互异：
 *   1. state-dir：sessions-index.json 是否落 env 指定目录（直连 spawn 路由入口、
 *      不带 --state-dir；不能经 launchBridge 的 extraEnv 传——它会把状态目录 env 键
 *      统一转成 --state-dir argv，argv 优先会掩盖 env 通道）；
 *   2. session-worker：路由 spawn 的 worker 进程环境里是否有该标记（观测通道是
 *      --step-cli 指向的一次性 env 转储脚本：worker 的底座子进程继承其 env 落盘）；
 *   3. storage-root：附件是否落 env 指定根目录而非 state-dir（--state-dir 走 argv
 *      是生产口径，本条考察的正是 storage-root 无 argv 等价物、env 是唯一通道）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchBridge, waitForExit } from "./helpers.mjs";

/** 路由入口（bin/zcode-bridge.mjs）：helpers 未导出，本套件本地引用。 */
const ROUTER_URL = new URL("../bin/zcode-bridge.mjs", import.meta.url);

/** 轮询直到 predicate 返回真值（落盘/子进程链路的异步时序缓冲）。 */
function pollUntil(predicate, { timeoutMs = 20000, label = "poll" } = {}) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			let value;
			try {
				value = predicate();
			} catch {
				value = undefined;
			}
			if (value) {
				clearInterval(timer);
				resolve(value);
			} else if (Date.now() - startedAt > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`timeout waiting for ${label}`));
			}
		}, 50);
	});
}

/** Windows 句柄延迟释放时的尽力清理（同 helpers.mjs 既有口径，临时目录兜底由系统清理）。 */
function cleanupDirOnExit(child, dir) {
	child.once("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 忽略：可能仍被 worker 短暂占用。
		}
	});
}

test("state-dir env 通道：仅设 env、不传 --state-dir，sessions-index 落 env 目录（R6 回归）", async () => {
	// env 键名运行时拼接（bridge-log-file.mjs 用例 2 同款；键名带 P，与 bin 读键同值）。
	const stateEnvKey = ["STEPCODE", "BRIDGE", "STATE", "DIR"].join("_");
	const dir = mkdtempSync(join(tmpdir(), "stepbridge-envdir-"));
	// 直连路由入口且不带 --state-dir argv：worker 只能经 env 键拿状态目录（路由 spawn
	// worker 时 spread process.env，env 键随之透传）。字面量键回归且命中宿主清洗时，
	// worker 的 STATE_DIR 静默落 homedir 默认目录，本用例在轮询处超时失败。
	const child = spawn(process.execPath, [fileURLToPath(ROUTER_URL)], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, [stateEnvKey]: dir },
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
	cleanupDirOnExit(child, dir);
	try {
		const sessionId = `envstate-${process.pid}`;
		send({
			id: 1,
			method: "session/create",
			params: { sessionId, workspace: { workspacePath: "C:/tmp/env-literal-passthrough" } },
		});
		// session/create 处理器内先 persistPrimarySummary 再回响应（methods-session.mjs），
		// 建会话摘要同步原子落盘；轮询仅作跨进程时序缓冲。
		const content = await pollUntil(
			() => {
				try {
					const text = readFileSync(join(dir, "sessions-index.json"), "utf8");
					return text.includes(sessionId) ? text : undefined;
				} catch {
					return undefined;
				}
			},
			{ label: `sessions-index 落 env 目录（stderr 尾部=${stderr.slice(-400)}）` },
		);
		assert.ok(content.includes(sessionId), "env 指定目录的状态文件必须包含本会话");
	} finally {
		// 先温和退出（stdin EOF → 路由 close() 收束 worker），超时兜底 kill。
		child.stdin.end();
		await waitForExit(child, { timeoutMs: 15000, label: "env-dir 路由优雅退出" }).catch(() => {
			try {
				child.kill();
			} catch {
				// 进程可能刚好退出。
			}
		});
	}
});

test("session-worker env 写入：路由 spawn 的 worker env 带拼接键身份标记（R6 回归）", async () => {
	const workerEnvKey = ["STEPCODE", "SESSION", "WORKER"].join("_");
	const dir = mkdtempSync(join(tmpdir(), "stepbridge-workerenv-"));
	const dumpFile = join(dir, "worker-env.json");
	// 观测通道：--step-cli 指向一次性 env 转储脚本（落盘即退，不说话协议）。脚本必须
	// 是真实文件而非 node -e：withDefaultLanguage 会在命令尾追加 --append-system-prompt
	// <中文长文>，node 会把它当成 node 自身 CLI 选项直接 bad option 退出（本轮实测），
	// -e 形态的脚本根本不执行；文件形态下追加参数只是无害 argv。worker 的
	// StepCodeRpcClient 以 {...process.env, ...凭据env} spawn 底座（rpc-client.mjs，
	// desktopShellEnvironment 只重排 PATH 不滤键），转储内容即 worker 进程环境——
	// session-router.mjs 注入的身份标记必须在其中。转储脚本退出后桥会报底座错误，
	// 不影响断言；桥自身仍走默认 --state-dir 临时目录隔离。
	const dumpScriptFile = join(dir, "dump-worker-env.cjs");
	writeFileSync(dumpScriptFile, `require("fs").writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(process.env));`);
	const b = launchBridge(["--step-cli", JSON.stringify([process.execPath, dumpScriptFile])]);
	cleanupDirOnExit(b.child, dir);
	try {
		b.send({
			id: 1,
			method: "v4/command",
			params: {
				commandId: "wenv-create",
				sessionId: "wenv-1",
				type: "createSession",
				payload: { firstInput: { text: "worker env 取证" }, workspaceId: "ws" },
			},
		});
		const env = await pollUntil(
			() => {
				try {
					return JSON.parse(readFileSync(dumpFile, "utf8"));
				} catch {
					return undefined;
				}
			},
			{ label: `worker env 转储落盘（stderr 尾部=${b.stderr.slice(-400)}）` },
		);
		assert.equal(env[workerEnvKey], "1", "路由必须以拼接键向 worker env 注入身份标记（env 通道不得被字面量清洗回归）");
	} finally {
		b.child.kill();
	}
});

test("storage-root env 通道：仅设 env，附件落 env 根目录而非 state-dir（R6 回归）", async () => {
	const storageEnvKey = ["STEPCODE", "STORAGE", "ROOT", "DIR"].join("_");
	const stateDir = mkdtempSync(join(tmpdir(), "stepbridge-storoot-state-"));
	const storageRoot = mkdtempSync(join(tmpdir(), "stepbridge-storoot-env-"));
	// state-dir 走 argv（生产确定性口径）；storage-root 无 argv 等价物、env 是唯一通道。
	// 字面量键回归且命中清洗时 STORAGE_ROOT 读不到 → 附件静默落 stateDir/attachments，
	// 下方两条断言失败。extraEnv 只含 storage 键，不触发 launchBridge 的状态目录
	// env→argv 转换。
	const b = launchBridge([], { [storageEnvKey]: storageRoot }, { stateDir });
	for (const dir of [stateDir, storageRoot]) cleanupDirOnExit(b.child, dir);
	try {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
		const bytes = Buffer.from(png, "base64");
		const p = {
			sessionId: "storoot-session",
			connectionId: "storoot-c",
			uploadId: "storoot-u",
			fileName: "clipboard.png",
			mime: "image/png",
			totalBytes: bytes.length,
			totalChunks: 1,
			checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		};
		b.send({ id: 2, method: "v4/attachment/begin", params: p });
		assert.equal((await b.waitFor((f) => f.id === 2)).result.state, "staging");
		b.send({ id: 3, method: "v4/attachment/chunk", params: { ...p, chunkIndex: 0, dataBase64: png } });
		assert.equal((await b.waitFor((f) => f.id === 3)).result.nextChunkIndex, 1);
		b.send({ id: 4, method: "v4/attachment/commit", params: p });
		await b.waitFor((f) => f.id === 4, { label: "attachment commit" });
		// AttachmentStore 寻址：root/attachments/<sha256(sessionId)>/<sha256(身份三元组)>.bin|.json
		const sessionDir = join(storageRoot, "attachments", createHash("sha256").update(p.sessionId).digest("hex"));
		const key = createHash("sha256").update(JSON.stringify([p.sessionId, p.connectionId, p.uploadId])).digest("hex");
		await pollUntil(() => existsSync(join(sessionDir, `${key}.bin`)), { label: "附件落 env 根目录" });
		assert.ok(existsSync(join(sessionDir, `${key}.bin`)), "附件二进制必须落 env 指定根目录");
		assert.ok(existsSync(join(sessionDir, `${key}.json`)), "附件元数据必须落 env 指定根目录");
		assert.equal(existsSync(join(stateDir, "attachments")), false, "state-dir 下不得出现附件目录（env 通道失效的静默落点）");
	} finally {
		b.child.kill();
	}
});
