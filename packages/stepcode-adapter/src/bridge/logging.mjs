/*
 * bridge 诊断日志（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）。
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import process from "node:process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COMMUNITY_BACKEND_LABEL } from "../wire-shapes.mjs";

const LOG_PREFIX = `[${COMMUNITY_BACKEND_LABEL} bridge]`;

/** 日志文件体积上限（字节）：写入前超过即截断重写（保留尾部一半，按行边界对齐）。 */
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 诊断落盘开关，两个通道（spec §10）：显式 argv `--log-file`（bin 解析后经
 * setBridgeLogFilePath 注入，与 --state-dir 同构——宿主对 STECODE_* env 及其字面量
 * 存在间歇性清洗，argv 是确定性通道，spec §8）优先；argv 未显式传入时保留模块
 * 加载时的 STECODE_BRIDGE_LOG_FILE env 初值，不清零（R4 评审 medium 修复：首版
 * bin 无条件注入 null 把 env 通道清零，属回归）。设置后 log() 的每一行（含进程
 * 启动行）best-effort 追加写入该文件。
 * 背景：生产态 host 不转发 bridge stderr（上游 zcodeAgentProcessManager 的
 * debugLog 仅开发态生效），stderr 只进内存尾部，app.log 全程无 bridge 日志——
 * contentRejected / 准入分支排查的盲区即在此。
 * 两通道都未设置时行为与历史逐字节一致（只走 stderr，零落盘）；任何写失败静默降级。
 * 写入用 appendFileSync（每行开-写-关），无常开句柄：进程退出时不存在待关闭的
 * 文件描述符，"退出时关闭"天然成立；多进程（路由透传 argv/env 后的多个 session
 * worker）对同一文件按行 append，行级原子性由 OS append 语义保证。但超限截断是
 * 「读全文-重写」的非原子窗口：并发截断瞬间其他进程正在 append 的个别行可能
 * 丢失——本通道是 best-effort 取证，不承诺跨进程严格不丢（spec §10）。
 */
// env 键名运行时拼接（helpers.mjs:144 先例 + spec §8）：宿主对源码中受保护前缀的
// 字面量存在「两套视图」清洗——readFileSync 读回的文件内容完好，但 node 执行层
// 对该字面量的 env 属性访问间歇读不到（本轮实测复现，详见套件头注释）。拼接键
// 不受影响，语义仍是 spec §10 的同名环境变量。
const BRIDGE_LOG_FILE_ENV_KEY = ["STECODE", "BRIDGE", "LOG", "FILE"].join("_");
let bridgeLogFilePath = process.env[BRIDGE_LOG_FILE_ENV_KEY]?.trim() || null;

/**
 * argv 通道注入点：bin/zcode-bridge-session.mjs 仅在 argv 显式传入 `--log-file`
 * 时调用（未传时不得调用——env 初值原样保留，对齐 --state-dir 的「显式 argv >
 * env」优先序，R4 评审 medium 修复）。显式传空/空白字符串恢复为不落盘（null 同，
 * 供测试恢复用）。
 * @param {string | null} path
 */
export function setBridgeLogFilePath(path) {
	bridgeLogFilePath = typeof path === "string" && path.trim() ? path.trim() : null;
}

/**
 * 超限截断重写：保留文件尾部一半（从中点后的第一个换行切齐，不切半行），并在
 * 头部落一行截断标记——近期（取证最相关）的准入决策日志不因截断整体丢失。
 * @returns {boolean} 截断是否成功（失败不阻断后续 append，由调用方兜底）
 */
function truncateLogFile(path, sizeBytes) {
	let retained = "";
	try {
		const content = readFileSync(path, "utf8");
		const halfIndex = Math.floor(content.length / 2);
		const newlineIndex = content.indexOf("\n", halfIndex);
		retained = newlineIndex === -1 ? content.slice(halfIndex) : content.slice(newlineIndex + 1);
	} catch {
		return false;
	}
	try {
		writeFileSync(path, `${LOG_PREFIX} [log truncated at ${sizeBytes} bytes ${new Date().toISOString()}]\n${retained}`, "utf8");
		return true;
	} catch {
		return false;
	}
}

export function log(...args) {
	const line = `${LOG_PREFIX} ${args.join(" ")}\n`;
	// stdout 是协议通道，诊断一律走 stderr。
	process.stderr.write(line);
	if (bridgeLogFilePath === null) return;
	try {
		try {
			// 简单体积上限：写入前查大小，超过 5MB 先截断重写再 append 本行。
			const { size } = statSync(bridgeLogFilePath);
			if (size > LOG_FILE_MAX_BYTES) truncateLogFile(bridgeLogFilePath, size);
		} catch {
			// 文件尚不存在（首行）或截断失败：不阻断，落到下方 append/mkdir 兜底。
		}
		appendFileSync(bridgeLogFilePath, line, "utf8");
	} catch {
		try {
			mkdirSync(dirname(bridgeLogFilePath), { recursive: true });
			appendFileSync(bridgeLogFilePath, line, "utf8");
		} catch {
			// 落盘不可用（路径非法/磁盘满等）：静默降级，后续只走 stderr。
			bridgeLogFilePath = null;
		}
	}
}
