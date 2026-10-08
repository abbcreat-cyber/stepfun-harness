/*
 * stepcode-switch-check.mts — 桌面壳侧 STEP_BACKEND 开关的行为验证（可复现）。
 *
 * 背景：desktop main 代码 import 了 electron 的 `app`，普通 node/tsx 进程无法
 * 直接加载；这里用 module.register 挂 electron-mock-loader.mjs 把 "electron"
 * mock 成 app.isPackaged=false 的 stub，再加载真实的
 * packages/desktop/src/main/stepcodeBackend.ts 断言五种场景：
 *
 *   1. 默认（不设 STEP_BACKEND）→ 空对象，官方链路零变化；
 *   2. STEP_BACKEND=stepcode-local → 注入 ZCODE_AGENT_SERVER_COMMAND=node
 *      + ARGS_JSON 指向 bin/zcode-bridge.mjs；
 *   3. 显式 ZCODE_AGENT_SERVER_COMMAND 已设 → 让步不覆盖；
 *   4. 门面缺失（STEPCODE_BRIDGE_ENTRY 指向不存在路径）→ 回落官方链路；
 *   5. STEPCODE_NODE 覆盖 node 可执行。
 *
 * 运行（stepcode-desktop 仓库根）：npx tsx packages/stepcode-adapter/tools/stepcode-switch-check.mts
 * （已挂 npm script：pnpm --filter stepcode-adapter run check:switch）
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import { register } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";

await register("./electron-mock-loader.mjs", import.meta.url);

const desktopRoot = new URL("../../", import.meta.url);
const moduleUrl = new URL("desktop/src/main/stepcodeBackend.ts", desktopRoot);
const bridgeUrl = new URL("../bin/zcode-bridge.mjs", import.meta.url);

const { resolveStepCodeCommunityBackendEnv, resolveStepCodeCommunityBackendStatus } = await import(moduleUrl);
const normalize = (path) => path.replaceAll("\\", "/");

function resetEnv() {
	delete process.env.STEP_BACKEND;
	delete process.env.ZCODE_AGENT_SERVER_COMMAND;
	delete process.env.STEPCODE_BRIDGE_ENTRY;
	delete process.env.STEPCODE_NODE;
}

/** @param {string} label @param {boolean} ok */
function check(label, ok) {
	console.log(`${ok ? "PASS" : "FAIL"} - ${label}`);
	if (!ok) process.exitCode = 1;
}

// 场景 1：默认关
resetEnv();
const off = resolveStepCodeCommunityBackendEnv({});
check("scenario1 默认不设 STEP_BACKEND → 空对象（官方链路零变化）", JSON.stringify(off) === "{}");

// 场景 2：打开
process.env.STEP_BACKEND = "stepcode-local";
const on = resolveStepCodeCommunityBackendEnv({});
const injectedArgs = on.ZCODE_AGENT_SERVER_ARGS_JSON ? JSON.parse(on.ZCODE_AGENT_SERVER_ARGS_JSON) : [];
check(
	"scenario2 STEP_BACKEND=stepcode-local → 注入 node + bridge 入口",
	on.ZCODE_AGENT_SERVER_COMMAND === "node" &&
		normalize(injectedArgs[0] ?? "") === normalize(fileURLToPath(bridgeUrl)),
);
const status = resolveStepCodeCommunityBackendStatus({});
check("scenario2 status → enabled/on", status.enabled === true && status.reason === "on");

// 场景 3：显式覆盖让步
process.env.ZCODE_AGENT_SERVER_COMMAND = "my-custom-agent";
const explicit = resolveStepCodeCommunityBackendEnv({});
check("scenario3 显式 ZCODE_AGENT_SERVER_COMMAND → 开关让步（空对象）", JSON.stringify(explicit) === "{}");

// 场景 4：门面缺失回落
delete process.env.ZCODE_AGENT_SERVER_COMMAND;
process.env.STEPCODE_BRIDGE_ENTRY = "C:/nonexistent/bridge.mjs";
const missing = resolveStepCodeCommunityBackendEnv({});
check("scenario4 门面缺失 → 回落官方链路（空对象）", JSON.stringify(missing) === "{}");

// 场景 5：STEPCODE_NODE 覆盖
delete process.env.STEPCODE_BRIDGE_ENTRY;
process.env.STEPCODE_NODE = "C:/custom/node.exe";
const customNode = resolveStepCodeCommunityBackendEnv({});
check("scenario5 STEPCODE_NODE → 覆盖 node 可执行", customNode.ZCODE_AGENT_SERVER_COMMAND === "C:/custom/node.exe");

resetEnv();
console.log(process.exitCode ? "SWITCH CHECK FAIL" : "SWITCH CHECK PASS");
