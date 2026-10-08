/**
 * zcode-bridge 套件（错误面）：发送失败归类为诚实中文错误（key / 模型不可用 / 兜底，
 * v4 与 legacy 两路）、session/setModel 对不存在的模型如实报错。
 * 从 zcode-bridge.mjs 机械拆分，用例逐字保留。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBridge } from "./zcode-bridge-launch.mjs";
import { waitForExit } from "./helpers.mjs";

test("bridge：发送失败归类为诚实中文错误（key / 模型不可用 / 兜底，v4 与 legacy 两路）", async () => {
	// 三轮共用时序：session/create（带模型）→ 发送 "mock:error" → 断言 error.message。
	// 错误引导跟随供应商与配置事实，不能再用重启或套餐提示代替真实分类。
	const round = async ({ extraEnv, sendFrame, expect, notExpect = [] }) => {
		const bridge = launchBridge([], extraEnv);
		try {
			bridge.send({
				id: 1,
				method: "session/create",
				params: {
					workspace: { workspacePath: "C:/tmp/suite-send-error" },
					model: { providerId: "step", modelId: "step-5-preview" },
				},
			});
			await bridge.waitFor((f) => f.id === 1, { label: "session/create" });
			bridge.send(sendFrame(2));
			const resp = await bridge.waitFor((f) => f.id === 2, { label: "发送失败响应" });
			assert.equal(resp.error?.code, -32000, `expect -32000, got ${JSON.stringify(resp)}`);
			for (const fragment of expect) {
				assert.ok(
					typeof resp.error?.message === "string" && resp.error.message.includes(fragment),
					`错误面应含「${fragment}」，实际：${resp.error?.message}`,
				);
			}
			for (const fragment of notExpect) {
				assert.ok(
					typeof resp.error?.message !== "string" || !resp.error.message.includes(fragment),
					`错误面不应含「${fragment}」（该成因下重启指引是误导），实际：${resp.error?.message}`,
				);
			}
			bridge.child.stdin.end();
			const { code: exitCode } = await waitForExit(bridge.child, { label: "bridge EOF 优雅退出（发送失败归类）" });
			assert.equal(exitCode, 0);
		} finally {
			if (bridge.child.exitCode === null) bridge.child.kill();
		}
	};

	const v4Send = (id) => ({
		id,
		method: "v4/command",
		params: { commandId: `cmd-err-${id}`, clientId: "suite", type: "sendText", payload: { text: "mock:error" }, issuedAt: Date.now() },
	});
	const legacySend = (id) => ({
		id,
		method: "session/send",
		params: { content: "mock:error" },
	});

	// 401 → key 问题（v4/command 路径）。
	await round({
		extraEnv: { STEP_MOCK_PROMPT_ERROR: "401 Unauthorized: invalid api key" },
		sendFrame: v4Send,
		expect: ["API Key 无效或已过期", "供应商 step", "原始错误：401 Unauthorized"],
	});
	// 404/模型不可用 → 指名道姓并检查地址、模型配置与访问权限。
	await round({
		extraEnv: { STEP_MOCK_PROMPT_ERROR: "404 Not Found: model step-5-preview is not available for your plan" },
		sendFrame: legacySend,
		expect: ["无法使用模型 step-5-preview", "模型配置", "原始错误：404 Not Found"],
		notExpect: ["重启应用或新建会话", "尚未在底层 CLI 注册"],
	});
	// 无权限（permission，无 Model not found 原文）→ 同上，不误导。
	await round({
		extraEnv: { STEP_MOCK_PROMPT_ERROR: "Permission denied: you do not have access to model step-5-preview" },
		sendFrame: v4Send,
		expect: ["无法使用模型 step-5-preview", "访问权限", "原始错误：Permission denied"],
		notExpect: ["重启应用或新建会话", "尚未在底层 CLI 注册"],
	});
	// Model not found → 配置未注册/已删除，保存有效配置或选择其他模型。
	await round({
		extraEnv: { STEP_MOCK_PROMPT_ERROR: "Model not found: deepseek/deepseek-flash" },
		sendFrame: v4Send,
		expect: [
			"无法使用模型 step-5-preview",
			"模型配置未注册或已删除",
			"保存有效配置",
			"原始错误：Model not found: deepseek/deepseek-flash",
		],
	});
	// CLI 凭据缺失 → 认证提示保留原文。
	await round({
		extraEnv: {},
		sendFrame: v4Send,
		expect: ["API Key 无效或已过期", "原始错误：No API key found for mock-provider"],
	});
});

test("bridge：session/setModel 对不存在的模型如实报错而非假装切换成功", async () => {
	const bridge = launchBridge();
	try {
		bridge.send({
			id: 1,
			method: "session/create",
			params: { workspace: { workspacePath: "C:/tmp/suite-set-model" } },
		});
		await bridge.waitFor((f) => f.id === 1, { label: "session/create" });

		// mock 的 set_model 对未知模型回 "Model not found: step/no-such-model"（success:false）。
		bridge.send({
			id: 2,
			method: "session/setModel",
			params: { model: { providerId: "step", modelId: "no-such-model" } },
		});
		const failure = await bridge.waitFor((f) => f.id === 2, { label: "setModel 失败响应" });
		assert.equal(failure.error?.code, -32000);
		assert.ok(
			typeof failure.error?.message === "string" &&
				failure.error.message.includes("无法使用模型 no-such-model"),
			`错误面应指名道姓，实际：${failure.error?.message}`,
		);
		assert.ok(failure.error.message.includes("原始错误：Model not found"));

		// 切回存在的模型仍成功（回归确认合法路径不受影响）。
		bridge.send({
			id: 3,
			method: "session/setModel",
			params: { model: { providerId: "step", modelId: "step-5-preview" } },
		});
		const ok = await bridge.waitFor((f) => f.id === 3, { label: "setModel 成功响应" });
		assert.equal(ok.result.settings.model.current.modelId, "step-5-preview");

		bridge.child.stdin.end();
		const { code: exitCode } = await waitForExit(bridge.child, { label: "bridge EOF 优雅退出（setModel 如实报错）" });
		assert.equal(exitCode, 0);
	} finally {
		if (bridge.child.exitCode === null) bridge.child.kill();
	}
});
