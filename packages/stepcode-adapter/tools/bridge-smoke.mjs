#!/usr/bin/env node
/*
 * bridge-smoke.mjs — zcode-bridge 的端到端冒烟：模拟桌面壳 host 侧的
 * 完整调用序列（provider/updateAccountConfig → session/create →
 * session/subscribe → v4/conversation/subscribe → v4/command sendText → EOF），
 * 断言每步响应与事件/帧到达。零依赖，node 直接跑。
 *
 * 注意：--step-cli 需 JSON 数组形态（如 --step-cli '["node","missing.mjs"]'）——
 * 字符串/坏 JSON 会被桥静默忽略并回落 mock CLI，冒烟照样 16/16 全绿；复验
 * 失败路径（如指向不存在脚本）时务必用 JSON 数组形态，别被假绿误导。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── 输出管道截断兜底（评审 R3 medium ①：EPIPE 未捕获异常绕过全部清理）────────
// `| head` / `| grep -m1` / CI 日志截断会提前关闭输出管道，此后 console.log /
// console.error 触发流级 EPIPE——不设防时以未捕获异常形态击穿主流程，成功尾部
// 与 catch 块的清理双双跳过，本轮自建的两个临时目录直接泄漏。两层设防：
// ① stdout/stderr 的 error 事件仅吞 EPIPE（管道已关，输出本就无处可去，进程逻辑
// 照常走完清理——`2>&1 | head` 形态下 stderr 与 stdout 同管道，须一并设防）；
// 其余错误码不吞，上抛成未捕获异常交给第②层兜底处置（评审 R4 low ②：无差别
// 吞掉会静默吃掉 EPIPE 之外的真错误）；
// ② uncaughtException/unhandledRejection 兜底复用既有清理尾部（kill 子进程 →
// 有界等 close → 清临时目录）后 exit(1)，与主流程的退出尾部经 exitTailStarted
// 互斥（先到先得，防清理双跑）。兜底的注册放在全部临时目录常量初始化之后
// （评审 R4 low ③：早于常量初始化触发时，清理引用 TDZ 常量抛 ReferenceError
// 被兜底自身 try/catch 吞掉，目录清理静默失效；注册点之前是纯同步代码段，流
// error 事件最早也要等事件循环派发——即第一个 await 之后，届时注册已完成）。
process.stdout.on("error", (error) => {
	// 仅吞 EPIPE；其余错误码上抛 → uncaughtException → 兜底尾部（kill/清理/exit(1)）。
	if (error?.code !== "EPIPE") throw error;
});
process.stderr.on("error", (error) => {
	if (error?.code !== "EPIPE") throw error;
});
let child = null; // spawn 前为 null：兜底若在 spawn 前触发，跳过 kill/等退出，只清临时目录。
let exitTailStarted = false; // 主流程成功尾部/catch 尾部/兜底尾部三者的互斥标记（谁先接管谁负责到底）。

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bridgePath = join(pkgRoot, "bin", "zcode-bridge.mjs");

// ── sessions-index 键控对齐（生产语义复刻，修 spec §7.6 红基线）──────────────
// 桥对 v4 createSession（payload 无 workspace）的会话摘要按 worker cwd 键控落盘
// （bin/zcode-bridge-session.mjs createSession 分支 → persistSessionSummary 按
// normalizeWorkspaceKey(cwd) 分桶）；生产 host 一律把桥进程 cwd 设为 workspacePath
// （zcodeAgentProcessManager spawn cwd=context.workspacePath），并用同一 workspace 键
// 订阅 sessions-index/<key>（zcodeTaskServiceAdapter → sessionsIndexTopic(
// resolveWorkspaceKey(...))）。冒烟此前用固定 topic 键 `ws-smoke` 且桥继承任意
// shell cwd——摘要键与 topic 键永不匹配，session.upserted delta 等待超时。
// 修法与生产完全同构：在专用 workspace 目录里启动桥（spawn cwd），并用该目录的
// 规范化键（normalizeWorkspaceKey 同款："/"→"\" + 小写）订阅。
const smokeWorkspaceDir = mkdtempSync(join(tmpdir(), "zcode-bridge-smoke-"));
const smokeWorkspaceKey = smokeWorkspaceDir.replaceAll("/", "\\").toLowerCase();
const sessionsIndexTopic = `sessions-index/${smokeWorkspaceKey}`;

// ── argv 透传 + 状态目录隔离（评审 R2 中危②：裸跑不得写生产共享默认状态目录）──
// 透传冒烟自身的额外 argv 给桥入口（如 `-- --state-dir <dir>`）：宿主环境对
// STECODE_* 环境变量存在间歇性清洗（spec §8），argv 是确定性隔离通道；桥入口对
// 未知参数容忍并经路由透传给 session worker（session-router.mjs spawn ...args）。
// pnpm run 会把分隔符 `--` 也作为字面参数传给脚本（实测运行命令回显含 "--"），剥掉。
const bridgeArgs = process.argv.slice(2);
if (bridgeArgs[0] === "--") bridgeArgs.shift();

// 未显式携带 --state-dir 时，桥的 STATE_DIR 会按「显式 argv → env → 默认目录」
// 三级回退落到生产共享默认目录 ~/.stepcode-desktop/bridge-state（本机真实数据
// 也在用），而冒烟的 workspace 目录是 mkdtemp 随机键——每裸跑一次就往那里
// 无限累积一个新 workspace 键的 sessions-index 摘要桶。隔离不能依赖调用者
// 记得带参数：冒烟自行 mkdtemp 隔离状态目录并经同一 argv 通道下发，成功/失败
// 退出路径都负责清理；显式 --state-dir 通道行为保持不变（原样透传、不清理——
// 目录归调用者所有，终验还要核显式目录的实际落盘产物）。
//
// 判定必须是桥 parseArgs 的完整同构（评审 R5 medium：R4 版只扫 --state-dir
// token、未建模其余吞值 flag，两类形态实测击穿——①吞值 flag 末位悬空（如
// `-- --auto-approve`）：尾部追加的 `--state-dir <隔离目录>` 的字面量被悬空
// flag 当值吃掉，隔离目录成孤儿 token，状态落生产默认目录且 16/16 假绿零
// 警告；②`-- --step-cli --state-dir <dir>`：--state-dir 字面量被 --step-cli
// 当 JSON 值吞掉（解析失败被桥忽略），同样落生产）。完整语义镜像
// bin/zcode-bridge-session.mjs parseArgs：
// ① 五个吞值 flag（--step-cli/--step-cwd/--auto-approve/--state-dir/--log-file）
//    一律无条件消费后随 token（哪怕后随又是 flag 字面量；越界=末位悬空=null）；
// ② --session-worker 是布尔 flag 不吞值；其余 token（含 --surface desktop）
//    逐个忽略、不吞值；
// ③ --state-dir 多次出现 last-assignment-wins，`argv[++i] ?? null` 悬空赋 null；
// ④ STATE_DIR 回退链 `options.stateDir?.trim() || env?.trim() || 生产默认目录`
//    ——null 与纯空白串等价（trim 后 falsy）。
// 主入口 zcode-bridge.mjs 不解析参数，session-router 只在 argv 头部前置布尔
// flag --session-worker（不吞值、对扫描不扰）——STATE_DIR 决策全部发生在
// session worker，单趟扫描 bridgeArgs 即与桥逐形态同构。
const VALUE_CONSUMING_FLAGS = ["--step-cli", "--step-cwd", "--auto-approve", "--state-dir", "--log-file"];

/** 桥 parseArgs 的单趟同构扫描：吞值 flag 全集消费后随 token，返回判定模型（语义依据见上方注释块）。 */
function scanBridgeStateDirArgs(args) {
	const scan = {
		lastStateDirFlagIndex: -1, // 最后一次「作为 flag 出现」的 --state-dir 下标（补洞锚点；被其他 flag 吞掉的字面量不算）
		effectiveStateDirValue: null, // 桥 last-assignment-wins 的生效赋值（悬空=null，与桥 `argv[++i] ?? null` 同构）
		tailAwaitsValue: false, // 尾部是否是「待值的吞值 flag」——真悬空（取值越界），而非「被前置 flag 吞掉的字面量」
		swallowedStateDirCount: 0, // --state-dir 字面量被其他吞值 flag 当值吃掉的次数（不再作为 flag 生效）
		danglingFlagNames: [], // 末位悬空的吞值 flag 名（含 --state-dir 自身）
		blankStateDirValueCount: 0, // --state-dir 作为 flag 赋了纯空白值的次数（悬空已单列，不计入）
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--state-dir") {
			scan.lastStateDirFlagIndex = i;
			const value = args[++i] ?? null; // 与桥同构：无条件消费后随 token，越界=悬空=null。
			scan.effectiveStateDirValue = value;
			if (value === null) {
				scan.danglingFlagNames.push(arg);
				scan.tailAwaitsValue = true; // 悬空的 --state-dir 自身就是待值尾部。
			} else if (!value.trim()) {
				scan.blankStateDirValueCount++;
			}
		} else if (VALUE_CONSUMING_FLAGS.includes(arg)) {
			const value = args[++i]; // 其余吞值 flag 同样无条件消费后随 token（含越界悬空）。
			if (value === undefined) {
				scan.danglingFlagNames.push(arg);
				scan.tailAwaitsValue = true; // 取值越界 ⇒ 末位真悬空：此后追加的任何 token 都会被它当值吃掉。
			} else if (value === "--state-dir") {
				scan.swallowedStateDirCount++; // 后随 --state-dir 字面量被当值吞掉，不再作为 flag。
			}
		}
		// --session-worker（布尔）与其余 token：桥不吞值，直接忽略。
	}
	return scan;
}

const initialScan = scanBridgeStateDirArgs(bridgeArgs);
// 畸形如实暴露（stderr）：悬空与被吞即使无需注入（退化赋值会被桥的后续赋值
// 覆盖）也打警告——调用者 argv 畸形值得看见，且两类正是评审 R5 medium 的击穿形态。
if (initialScan.danglingFlagNames.length > 0) {
	console.warn(`# 警告：吞值 flag 末位悬空（无后随 token 可取值）：${initialScan.danglingFlagNames.join(" ")}——该 flag 取值永远落空，且尾部追加的任何 token 都会被它当值吃掉`);
}
if (initialScan.swallowedStateDirCount > 0) {
	console.warn(`# 警告：检测到 ${initialScan.swallowedStateDirCount} 处 --state-dir 字面量被其他吞值 flag 当值吞掉（不再作为 flag 生效，桥将其按 env→生产默认目录回退处理）`);
}
if (initialScan.blankStateDirValueCount > 0) {
	console.warn(`# 警告：检测到 ${initialScan.blankStateDirValueCount} 处 --state-dir 值为空白串（桥的 trim 口径下该处不产生有效目录，末次赋值若是则回退 env→生产默认目录）`);
}
const hasExplicitStateDir = initialScan.effectiveStateDirValue !== null && !!initialScan.effectiveStateDirValue.trim();
const smokeStateDir = hasExplicitStateDir ? null : mkdtempSync(join(tmpdir(), "stepbridge-smoke-state-"));
if (smokeStateDir) {
	// 注入策略（评审 R5 medium 重构；R4 medium ① 的原地补洞是其子集）：
	// A. 有「作为 flag 出现」的 --state-dir 且末次赋值退化（悬空/空白）→ 原地
	//    补洞：把末次赋值（桥 last-assignment-wins 下实际生效的那次）的值槽
	//    改写为隔离目录。末位悬空时 index+1 越界，赋值等价 push，恰好补成
	//    完整对；空白值则原地替换。末次 flag 之后再无 --state-dir 赋值，改写
	//    即生效。
	// B. 全程无 --state-dir 作为 flag（缺失或全部被其他 flag 吞掉）：
	//    B1. 尾部是待值的吞值 flag → 不能尾部追加（--state-dir 字面量会被它
	//        当值吃掉，评审 R5 medium 实测击穿形态①）；也不能给悬空 flag 补
	//        哑值（--step-cwd/--log-file 补值会真改语义）——把完整对 splice 到
	//        悬空 flag 之前。悬空 flag 保持悬空，其语义与注入前逐形态一致：
	//        --step-cli 坏 JSON 被桥忽略、--auto-approve 取 undefined≠"1"、
	//        --step-cwd/--log-file 取 null。
	//    B2. 尾部无待值 flag（含空 argv）→ 尾部追加完整对——扫描已证没有任何
	//        token 在等着吞值，追加安全（旧注释「无悬空 token 可吞值」只对
	//        --state-dir 自身成立，对其他吞值 flag 不成立，故以扫描结论为准）。
	if (initialScan.lastStateDirFlagIndex >= 0) bridgeArgs[initialScan.lastStateDirFlagIndex + 1] = smokeStateDir;
	else if (initialScan.tailAwaitsValue) bridgeArgs.splice(bridgeArgs.length - 1, 0, "--state-dir", smokeStateDir);
	else bridgeArgs.push("--state-dir", smokeStateDir);
	// 注入后自校验（fail-fast 拒跑）：对最终 bridgeArgs 重跑同构扫描，生效值
	// 不是刚注入的隔离目录 = 注入没生效——继续跑桥只会按评审 R5 medium 实测
	// 那样 16/16 假绿写生产目录，直接拒跑。按上述分支构造理论上不可能失败，
	// 这是防未来语义漂移（如桥新增吞值 flag 而本判定未跟上）的硬闸。
	const finalScan = scanBridgeStateDirArgs(bridgeArgs);
	if (finalScan.effectiveStateDirValue !== smokeStateDir) {
		await failFastExit(
			"state-dir-isolation",
			new Error(`隔离状态目录注入未生效（同构复扫生效值=${JSON.stringify(finalScan.effectiveStateDirValue)}，期望=${smokeStateDir}）——拒跑以防假绿写生产目录`),
		);
	}
	console.log(
		initialScan.lastStateDirFlagIndex >= 0
			? `# 退化的 --state-dir 已原地改写为隔离状态目录（桥最后一次赋值生效，退出时清理）：${smokeStateDir}`
			: initialScan.tailAwaitsValue
				? `# 已在悬空吞值 flag 之前插入隔离状态目录（注入点避开待值尾部，退出时清理）：${smokeStateDir}`
				: `# 未收到显式 --state-dir，已自建隔离状态目录（退出时清理）：${smokeStateDir}`,
	);
}

// ── 未捕获异常兜底尾部（评审 R3 medium ① 第②层；注册后置修 R4 low ③ TDZ）──────
// 定义与注册都放在 smokeWorkspaceDir/smokeStateDir 两个临时目录常量初始化之后：
// 若在常量初始化前注册并被触发，cleanupTempDirs 引用 TDZ 常量会抛
// ReferenceError、被兜底自身 try/catch 吞掉，目录清理静默失效。注册点之前的
// 全部代码是纯同步段，uncaughtException/unhandledRejection 与流 error 事件最早
// 也要等事件循环派发（第一个 await 之后），届时注册已完成，不存在无兜底窗口。
// waitForChildClose/cleanupTempDirs 是函数声明（整体提升），此处引用无碍。
async function failFastExit(origin, error) {
	if (exitTailStarted) return;
	exitTailStarted = true;
	process.exitCode = 1; // 先落退出码：即便下方清理自身出意外（极端时连自然退出也按失败计）。
	console.error(`SMOKE FAIL(${origin}): ${error?.stack ?? error}`);
	try {
		child?.kill();
		if (child) await waitForChildClose(child, { timeoutMs: 3000 });
		await cleanupTempDirs();
	} catch {
		// 兜底自身失败不再追抛（防二次未捕获把清理半途掐断）。
	}
	process.exit(1);
}
process.on("uncaughtException", (error) => void failFastExit("uncaughtException", error));
process.on("unhandledRejection", (reason) => void failFastExit("unhandledRejection", reason));

/**
 * rmSync 带退避重试（评审 R2 低危：临时目录 EBUSY 泄漏）。Windows 上子进程与
 * 路由派生的孙 session worker 刚退出时，cwd 与状态文件句柄可能延迟数百毫秒才
 * 释放，一次性删除会 EBUSY 泄漏临时目录。有界：到期或遇到不可重试错误码即
 * 放弃（残留交由系统临时目录清理），不抛错、不影响冒烟自身的退出码判定。
 */
async function rmSyncWithRetry(dir, { deadlineMs = 3000, stepMs = 100 } = {}) {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || Date.now() + stepMs >= deadline) return;
			await new Promise((resolve) => setTimeout(resolve, stepMs));
		}
	}
}

/** 等 child 'close'（晚于 'exit'：stdio 全部收口，句柄释放更彻底）；有界兜底，超时返回 null 后继续走 best-effort 清理。 */
function waitForChildClose(child, { timeoutMs = 3000 } = {}) {
	return new Promise((resolve) => {
		const finish = (code) => {
			clearTimeout(timer);
			resolve(code);
		};
		const timer = setTimeout(() => {
			child.removeListener("close", finish);
			resolve(null);
		}, timeoutMs);
		child.once("close", finish);
	});
}

/** 清理本冒烟持有的全部临时目录：workspace 键控目录 + 自建的隔离状态目录（显式 --state-dir 传入的目录归调用者所有，不在此列）。 */
async function cleanupTempDirs() {
	await Promise.all(
		[smokeWorkspaceDir, ...(smokeStateDir ? [smokeStateDir] : [])].map((dir) => rmSyncWithRetry(dir)),
	);
}

// ── 启动清扫 %TEMP% 陈旧冒烟目录（评审 R3 medium ① 自愈：EPIPE 时代泄漏的存量）──
// 只认本工具自己的两个 mkdtemp 前缀（stepbridge-smoke-state-* / zcode-bridge-smoke-*），
// 且只清修改时间超过 6 小时的目录：年龄门槛确保并发冒烟与刚 mkdtemp 的本进程
// 目录绝不会被误删（另显式跳过本进程自己的两个目录作双保险）。任何清扫失败
// 都吞掉——自愈逻辑绝不能反过来砸了冒烟本体。测试套件族的其他前缀
// （stepbridge-*/bridge-image-* 等）归 suites 归属代理处置，此处不碰。
const STALE_SWEEP_PREFIXES = ["stepbridge-smoke-state-", "zcode-bridge-smoke-"];
const STALE_SWEEP_AGE_MS = 6 * 60 * 60 * 1000;
async function sweepStaleSmokeDirs() {
	try {
		const now = Date.now();
		for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
			if (!entry.isDirectory() || !STALE_SWEEP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
			const dir = join(tmpdir(), entry.name);
			if (dir === smokeWorkspaceDir || dir === smokeStateDir) continue;
			let mtimeMs;
			try {
				({ mtimeMs } = statSync(dir));
			} catch {
				continue;
			}
			if (now - mtimeMs < STALE_SWEEP_AGE_MS) continue;
			console.log(`# 清扫陈旧冒烟目录（>6h，EPIPE 时代泄漏自愈）：${dir}`);
			await rmSyncWithRetry(dir);
		}
	} catch {
		// 清扫失败不影响冒烟本体。
	}
}
await sweepStaleSmokeDirs();

child = spawn(process.execPath, [bridgePath, ...bridgeArgs], { cwd: smokeWorkspaceDir, stdio: ["pipe", "pipe", "pipe"] });
const frames = [];
const stderrLines = [];
let stdoutBuf = "";
let sessionId = null;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	stdoutBuf += chunk;
	let index;
	while ((index = stdoutBuf.indexOf("\n")) !== -1) {
		const line = stdoutBuf.slice(0, index);
		stdoutBuf = stdoutBuf.slice(index + 1);
		if (line.trim()) frames.push(JSON.parse(line));
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderrLines.push(chunk));

function send(frame) {
	child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function waitFor(predicate, { timeoutMs = 15000, label = "frame" } = {}) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			const found = frames.find(predicate);
			if (found) {
				clearInterval(timer);
				resolve(found);
			} else if (Date.now() - startedAt > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`timeout waiting for ${label}; got ${frames.length} frames: ${frames.map((f) => f.method ?? `resp:${f.id}`).join(", ")}`));
			}
		}, 50);
	});
}

function assert(condition, message) {
	// 失败统一抛给主流程 catch：kill 子进程 → 等退出 → 清理临时目录 → exit(1)。
	// 旧版直接 process.exit(1) 会孤儿化桥进程（只能靠 stdin EOF 传播各自退出），
	// 且完全跳过 workspace/状态临时目录清理（评审 R2 低危的同族泄漏点）。
	if (!condition) throw new Error(message);
	console.log(`ok - ${message}`);
}

/** v4/conversation/frame 的 params 是 topic wire 信封（payload 在 params.frame.payload）；兼容裸内层帧的旧格式读取。 */
function framePayloadOf(frame) {
	return frame.params?.frame?.payload ?? frame.params?.payload;
}

try {
	// 1. account config
	send({ id: 1, method: "provider/updateAccountConfig", params: { revision: "rev-1", providers: { zai: {} } } });
	const accountConfig = await waitFor((f) => f.id === 1, { label: "accountConfig response" });
	assert(accountConfig.result?.status === "received" && accountConfig.result?.receivedRevision === "rev-1", "provider/updateAccountConfig 往返");

	// 2. session create
	send({
		id: 2,
		method: "session/create",
		params: { workspace: { workspacePath: "C:/tmp/smoke", workspaceKey: "C:/tmp/smoke" }, model: { providerId: "step", modelId: "step-5-preview" } },
	});
	const created = await waitFor((f) => f.id === 2, { label: "session/create response" });
	sessionId = created.result?.session?.sessionId;
	assert(sessionId && created.result?.protocol?.name === "ZCode Protocol", `session/create snapshot (sessionId=${sessionId})`);
	assert(Array.isArray(created.result?.messages) && created.result.messages.length === 0, "snapshot.messages 为空数组");

	// 3. legacy subscribe
	send({ id: 3, method: "session/subscribe", params: { sessionId, deliveryKind: "live" } });
	const subscribed = await waitFor((f) => f.id === 3, { label: "session/subscribe response" });
	assert(subscribed.result?.sessionId === sessionId, "session/subscribe 往返");

	// 4. v4 conversation subscribe + 初始帧
	send({ id: 4, method: "v4/conversation/subscribe", params: { topic: `conversation/${sessionId}`, connectionId: "conn-1", clientMode: "desktop-continuous" } });
	const v4sub = await waitFor((f) => f.id === 4, { label: "v4 subscribe ack" });
	assert(v4sub.result?.ack?.subscriptionId && v4sub.result.ack.mode === "snapshot", "v4/conversation/subscribe ACK");
	const initialFrame = await waitFor((f) => f.method === "v4/conversation/frame" && f.params?.topic === `conversation/${sessionId}`, { label: "initial v4 frame" });
	assert(framePayloadOf(initialFrame)?.kind === "snapshot", "初始 snapshot 帧到达");

	// 5. v4 command sendText（mock 剧本回复 "Hello..."）
	send({
		id: 5,
		method: "v4/command",
		params: {
			commandId: "cmd-smoke-1",
			clientId: "smoke",
			sessionId,
			type: "sendText",
			payload: { text: "hi" },
			issuedAt: Date.now(),
		},
	});
	const ack = await waitFor((f) => f.id === 5, { label: "v4 command ack" });
	assert(ack.result?.status === "accepted" && ack.result?.result?.type === "inputAccepted", "v4/command sendText ACK(inputAccepted)");

	// 6. 等 turn 完成：legacy turn.completed 事件 + 更新后的 v4 snapshot 帧
	const turnCompleted = await waitFor(
		(f) => f.method === "session/event" && f.params?.type === "turn.completed",
		{ timeoutMs: 30000, label: "turn.completed 事件" },
	);
	assert(turnCompleted.params?.payload?.resultType === "success", "turn.completed(resultType=success)");
	const framesBeforeSend = frames.filter((f) => f.method === "v4/conversation/frame").length;
	const updatedFrame = await waitFor(
		(f) => f.method === "v4/conversation/frame" && (framePayloadOf(f)?.snapshot?.rows?.window?.length ?? 0) >= 3,
		{ timeoutMs: 20000, label: "turn 后的 snapshot 帧（含行）" },
	);
	const rowWindow = framePayloadOf(updatedFrame).snapshot.rows.window;
	const kinds = rowWindow.map((row) => row.kind).join(",");
	assert(
		kinds.includes("userInput") && kinds.includes("assistantText") && kinds.includes("turnHeader"),
		`snapshot 帧行投影完整 (${kinds})`,
	);

	// 6.5 sessions-index：先订阅（空基线 snapshot），再建第二个会话（v4 createSession），
	// 断言桥补发 session.upserted delta（fromSeq 衔接 snapshot 的 toSeq）——社区侧栏
	// 「任务」列表的写入路径就靠这帧（zcodeTaskIndexSyncer 只消费 sessions-index 帧）。
	// topic 键 = 冒烟 workspace 目录的规范化键：第二个 createSession 落在独立 worker，
	// 其摘要按 worker cwd（= 桥 cwd = smokeWorkspaceDir）键控落盘，只有同键订阅才能
	// 经状态文件 + bridge/sessionIndexChanged → bridge/refreshSessionIndex 收到 delta。
	send({
		id: 7,
		method: "v4/conversation/subscribe",
		params: { topic: sessionsIndexTopic, connectionId: "conn-2", clientMode: "desktop-continuous" },
	});
	const indexSub = await waitFor((f) => f.id === 7, { label: "sessions-index subscribe ack" });
	assert(indexSub.result?.ack?.subscriptionId, "sessions-index subscribe ACK");
	const indexSnapshot = await waitFor(
		(f) => f.method === "v4/conversation/frame" && f.params?.topic === sessionsIndexTopic && framePayloadOf(f)?.kind === "snapshot",
		{ label: "sessions-index 初始 snapshot" },
	);
	const indexSnapshotToSeq = indexSnapshot.params.frame?.toSeq ?? indexSnapshot.params.toSeq;
	assert(Array.isArray(framePayloadOf(indexSnapshot)?.snapshot?.sessions), "sessions-index snapshot 结构合法");
	send({
		id: 8,
		method: "v4/command",
		params: {
			commandId: "cmd-smoke-create",
			clientId: "smoke",
			sessionId: "step-session-smoke-2",
			type: "createSession",
			payload: { config: { modelSelection: { providerId: "step", modelId: "step-5-preview" } } },
			issuedAt: Date.now(),
		},
	});
	const createAck = await waitFor((f) => f.id === 8, { label: "v4 createSession ack" });
	assert(createAck.result?.result?.type === "createSession", "v4 createSession ACK");
	const upsertFrame = await waitFor(
		(f) =>
			f.method === "v4/conversation/frame" &&
			f.params?.topic === sessionsIndexTopic &&
			framePayloadOf(f)?.kind === "deltas" &&
			framePayloadOf(f)?.deltas?.some((delta) => delta.op === "session.upserted"),
		{ label: "sessions-index session.upserted delta" },
	);
	const upsertInner = upsertFrame.params.frame ?? upsertFrame.params;
	const upsertDelta = framePayloadOf(upsertFrame).deltas.find((delta) => delta.op === "session.upserted");
	assert(
		upsertInner.fromSeq === indexSnapshotToSeq && upsertInner.toSeq > upsertInner.fromSeq,
		`sessions-index delta 衔接 (fromSeq=${upsertInner.fromSeq} snapshotToSeq=${indexSnapshotToSeq})`,
	);
	assert(
		upsertDelta.session.sessionId === "step-session-smoke-2" && typeof upsertDelta.session.title === "string" && upsertDelta.session.title.length > 0,
		`session.upserted 摘要完整 (title=${JSON.stringify(upsertDelta.session.title)})`,
	);

	// 7. 未知方法 → -32601（workspace/readPresentation 已实现，改用不存在的方法名）
	send({ id: 6, method: "session/nonexistentSmokeMethod", params: {} });
	const notFound = await waitFor((f) => f.id === 6, { label: "unknown method error" });
	assert(notFound.error?.code === -32601, "未知方法回 -32601");

	// 8. EOF 优雅退出
	child.stdin.end();
	const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
	assert(exitCode === 0, `EOF 后优雅退出 (code=${exitCode})`);

	console.log(`\nSMOKE PASS: ${frames.length} 帧往返，turn 完成后行数=${rowWindow.length}（EOF 前帧数=${framesBeforeSend}）`);
	// 路由 close() 已等全部 worker 退出才 exit(0)，但 Windows 句柄释放仍可能滞后：
	// 先等 stdio 全收口（'close' 晚于 'exit'），再带退避重试地清理，杜绝 EBUSY 泄漏。
	exitTailStarted = true; // 本尾部接管退出后，兜底尾部不再重复清理。
	await waitForChildClose(child, { timeoutMs: 3000 });
	await cleanupTempDirs();
	process.exit(0);
} catch (error) {
	exitTailStarted = true; // 同上：catch 尾部接管退出后，兜底尾部不再重复清理。
	console.error(`SMOKE FAIL: ${error.message}`);
	console.error(`frames: ${JSON.stringify(frames.slice(-6), null, 2)}`);
	console.error(`stderr: ${stderrLines.join("")}`);
	child.kill();
	// Windows 的 kill()（TerminateProcess）落地是异步的，且路由派生的孙 session
	// worker 还要各自经 stdin EOF 退出——先等子进程结束（有界 3s 兜底），再带
	// 退避重试地清理，避免「kill 后立即 rmSync」的 EBUSY 泄漏（评审 R2 低危）。
	await waitForChildClose(child, { timeoutMs: 3000 });
	await cleanupTempDirs();
	process.exit(1);
}
