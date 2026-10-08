/**
 * R6 挂载（第五轮评审 medium ②）：把 shared 包的协议级透传防线挂进本聚合门禁。
 *
 * 背景：`packages/shared/test/stepInputAcceptedAckPassthrough.test.ts` 锁
 * 「commandAckSchema.parse 输出里 fallbackReasonCode 存活」（shared inputAccepted
 * 声明被删时 zod strip 未知键且不报错，该测试必红）。此前它只存在于手动命令，
 * 未挂任何聚合/门禁入口（R5 评审 medium）。
 *
 * 为什么是 tsx 子进程而不是直接 import：shared/src 全树是 TS 的 .js 扩展名
 * import 惯例（command.ts 内部 import "../localTtft.js"），本门禁的纯
 * `node --test` 原生 type-stripping 不做 .js→.ts 回退解析（Node 24 实测
 * ERR_MODULE_NOT_FOUND），跨包直引会拖垮整个聚合入口；子进程加 `--import tsx`
 * （tsx 是本包 dependencies，从 adapter cwd 解析）即可完整加载，门禁命令零改动。
 * 子进程断言 exit 0 + tests===pass + fail===0：声明被删时子进程 exit 1，本包装
 * 用例把子进程完整输出附进断言消息，保留「被删必红」的取证（zod strip 红样）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const adapterRoot = resolve(here, "..");
const sharedTestFile = resolve(here, "..", "..", "shared", "test", "stepInputAcceptedAckPassthrough.test.ts");

/** 从 spec reporter 输出里取 "ℹ <key> <n>" 行的数值。 */
const countOf = (output, key) => {
	const m = output.match(new RegExp(`[ℹi]\\s+${key}\\s+(\\d+)`));
	return m ? Number(m[1]) : NaN;
};

test("shared 透传防线（tsx 子进程跑 stepInputAcceptedAckPassthrough.test.ts，声明被删必红）", () => {
	// 剥掉 node --test 注入给测试文件的 NODE_TEST_CONTEXT：不剥的话子进程的
	// node:test 认为自己运行在测试上下文里（"run() is being called recursively"），
	// 跳过所有测试文件、exit 0 且零输出，包装断言拿不到任何计数。
	const childEnv = { ...process.env };
	delete childEnv.NODE_TEST_CONTEXT;
	const res = spawnSync(process.execPath, ["--import", "tsx", "--test", sharedTestFile], {
		cwd: adapterRoot,
		env: childEnv,
		encoding: "utf8",
		timeout: 120_000,
	});
	const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
	assert.equal(
		res.error,
		undefined,
		`shared 透传测试子进程未跑起来：${res.error ?? "(未知错误)"}`,
	);
	const [tests, pass, fail] = ["tests", "pass", "fail"].map((k) => countOf(output, k));
	assert.ok(
		res.status === 0 && Number.isFinite(tests) && tests >= 1 && tests === pass && fail === 0,
		`shared 透传测试未全绿（exit=${res.status}；tests=${tests} pass=${pass} fail=${fail}）——若红，以下为子进程完整输出（含 zod strip 红样取证）：\n${output}`,
	);
});
