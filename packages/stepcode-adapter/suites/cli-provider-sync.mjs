/**
 * cli-provider-sync 套件（R8-3 真实缺口的协议级复刻与修复验证）。
 *
 * 缺口背景（R4 状态文档 §1.8 / R8-3）：桌面自定义供应商（DeepSeek）的凭据只存
 * 桌面层，执行走桥接→step CLI，CLI 的 models.json 没有该供应商 → set_model 被拒
 * "Model not found: deepseek/deepseek-flash"。宿主侧同步（services 层
 * cliProviderSync，每次桥 spawn 前 + 个人供应商配置变更时把桌面个人供应商按
 * Step CLI 原生 models.json 自定义供应商四件套同步进 CLI 的 models.json）是
 * 修复；本套件用 STEP_MOCK_MODELS_FILE 晚绑定注入面在协议级锁住修复的可观测
 * 行为与诚实失败边界（不静默回退默认模型）。
 *
 * 凭据纪律：models.json 条目一律用 fixture 假 Key（sk-fixture-*）；任何断言都
 * 不触碰真实凭据。STEP_MOCK_MODELS_FILE 只影响 mock 的模型清单合并（默认关闭，
 * 未设时行为与现状逐字节一致）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBridge } from "./helpers.mjs";

/** fixture 假 Key（绝不使用真实凭据）。 */
const DEEPSEEK_FIXTURE_KEY = "sk-fixture-deepseek-1";
const DEEPSEEK_EMPTY_KEY = "";

/** 同步产物形状=Step CLI models.json 原生自定义供应商四件套（与 services 侧 syncCustomProvidersToStepCliModelsFile 的写盘形状一致）。 */
function deepseekProviderEntry(apiKey) {
	return {
		api: "anthropic-messages",
		baseUrl: "https://api.deepseek.com/anthropic",
		apiKey,
		models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
	};
}

/**
 * openai-responses 方言条目（评审 R5 low⑭ 的 mock 验证）：CLI 侧 KnownApi 原生含
 * 同名方言（Step-Code packages/providers/src/types.ts:10；compat.ts:160-164
 * BUILTIN_APIS 注册 openAIResponsesApi 实装），两侧枚举名相同可直通、无需翻译。
 * 本用例在协议级锁住「api:"openai-responses" 的自定义供应商条目经桥 set_model
 * 可选可用」，作为放开桌面侧映射表（cliProviderSync 同名直通）的前置验证。
 */
function responsesProviderEntry(apiKey) {
	return {
		api: "openai-responses",
		baseUrl: "https://api.example-responses.com/v1",
		apiKey,
		models: [{ id: "resp-test-1" }],
	};
}

/** 临时 models.json 写盘辅助（宿主同步函数的测试侧替身：整文件写入）。 */
function writeModelsFile(filePath, providers) {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, JSON.stringify({ providers }, null, 2), "utf8");
}

function sendCommand(b, id, params) {
	b.send({ id, method: "v4/command", params });
	return b.waitFor((f) => f.id === id, { label: `v4/command ${params.commandId}` });
}

async function createAndSubscribe(b, sessionId, baseId) {
	await sendCommand(b, baseId, {
		commandId: `create-${sessionId}`,
		sessionId,
		type: "createSession",
		payload: { workspaceId: "ws" },
	});
	b.send({
		id: baseId + 1,
		method: "v4/conversation/subscribe",
		params: { topic: `conversation/${sessionId}`, connectionId: `c-${sessionId}`, clientMode: "desktop-continuous" },
	});
	await b.waitFor((f) => f.id === baseId + 1, { label: `订阅 ${sessionId}` });
}

function snapshotRows(b, sessionId) {
	const last = b.frames
		.filter((f) => f.params?.topic === `conversation/${sessionId}` && f.params.frame?.payload?.snapshot?.rows)
		.at(-1)?.params.frame.payload.snapshot;
	return last?.rows?.window ?? [];
}

/** 等待某会话出现对 text 的完整回复行，返回该行（assistantText.model = 底座真实模型）。 */
function waitForAssistantReply(b, sessionId, text) {
	const match = (r) => r.kind === "assistantText" && r.state !== "streaming" && r.text?.includes(`mock reply to: ${text}`);
	return b
		.waitFor(
			(f) =>
				f.params?.topic === `conversation/${sessionId}` &&
				(f.params.frame?.payload?.snapshot?.rows?.window ?? []).some(match),
			{ label: `${sessionId} 的回复行（${text}）` },
		)
		.then(() => snapshotRows(b, sessionId).find(match));
}

test("cli-provider-sync：未同步（无 models.json 注入）→ deepseek 模型切换如实报错且绝不静默回退默认模型（复刻 R8-3）", async () => {
	const b = launchBridge();
	try {
		await createAndSubscribe(b, "cli-sync-unsynced", 1);

		// 显式 deepseek 模型选择：mock 的 set_model 找不到 deepseek/deepseek-flash → 桥接归类为诚实中文错误。
		const failure = await sendCommand(b, 10, {
			commandId: "cli-sync-unsynced-send-1",
			sessionId: "cli-sync-unsynced",
			type: "sendText",
			payload: { text: "这条不该由 step-5-preview 执行", modelSelection: { providerId: "deepseek", modelId: "deepseek-flash" } },
		});
		assert.ok(failure.error, "未同步时 deepseek 模型选择必须回错误，不得回 accepted");
		assert.equal(failure.error.code, -32000);
		for (const fragment of [
			"无法使用模型 deepseek-flash",
			"Model not found: deepseek/deepseek-flash",
			"底座模型配置未注册或已删除",
			"保存有效配置或选择可用模型后重试",
		]) {
			assert.ok(
				typeof failure.error.message === "string" && failure.error.message.includes(fragment),
				`错误面应含「${fragment}」，实际：${failure.error?.message}`,
			);
		}

		// 不静默回退：该次发送无 assistantText/turn.completed——消息未由默认模型冒充执行。
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.ok(
			!snapshotRows(b, "cli-sync-unsynced").some((r) => JSON.stringify(r).includes("这条不该由 step-5-preview 执行")),
			"被拒消息不得出现在会话行里",
		);
		assert.ok(
			!b.frames.some((f) => f.params?.type === "turn.completed" && f.params.sessionId === "cli-sync-unsynced"),
			"不得有 turn 执行（不得静默回退默认模型执行）",
		);

		// 会话仍可用：后续不带模型选择的发送走默认模型（与 R8-4 切回原模型语义一致）。
		const ok = await sendCommand(b, 11, {
			commandId: "cli-sync-unsynced-send-2",
			sessionId: "cli-sync-unsynced",
			type: "sendText",
			payload: { text: "默认模型恢复验证" },
		});
		assert.equal(ok.result.status, "accepted");
		const reply = await waitForAssistantReply(b, "cli-sync-unsynced", "默认模型恢复验证");
		assert.equal(reply.model, "step-5-preview", "失败后默认模型路径不受影响");
	} finally {
		b.child.kill();
	}
});

test("cli-provider-sync：已同步（spawn 前写好 models.json）→ deepseek 切换成功、同会话续发仍由 deepseek-flash 执行", async () => {
	const modelsDir = mkdtempSync(join(tmpdir(), "step-cli-provider-sync-"));
	const modelsFilePath = join(modelsDir, "models.json");
	writeModelsFile(modelsFilePath, { deepseek: deepseekProviderEntry(DEEPSEEK_FIXTURE_KEY) });
	const b = launchBridge([], { STEP_MOCK_MODELS_FILE: modelsFilePath });
	try {
		await createAndSubscribe(b, "cli-sync-synced", 1);

		const first = await sendCommand(b, 10, {
			commandId: "cli-sync-synced-send-1",
			sessionId: "cli-sync-synced",
			type: "sendText",
			payload: { text: "同步后首发", modelSelection: { providerId: "deepseek", modelId: "deepseek-flash" } },
		});
		assert.equal(first.result.status, "accepted", `同步后模型选择不应报错：${first.error?.message}`);
		const reply1 = await waitForAssistantReply(b, "cli-sync-synced", "同步后首发");
		assert.equal(reply1.model, "deepseek-flash", "回复行模型=同步条目里的 deepseek-flash（底座真实模型）");

		// 同会话续发（不带 modelSelection）：沿用上一条落定的模型，而不是回落进程默认。
		const second = await sendCommand(b, 11, {
			commandId: "cli-sync-synced-send-2",
			sessionId: "cli-sync-synced",
			type: "sendText",
			payload: { text: "同步后续发" },
		});
		assert.equal(second.result.status, "accepted");
		const reply2 = await waitForAssistantReply(b, "cli-sync-synced", "同步后续发");
		assert.equal(reply2.model, "deepseek-flash", "续发必须仍由 deepseek-flash 执行");

		// get_state 回读一致：桥接会话快照的模型字段=deepseek-flash。
		const lastSnapshot = b.frames
			.filter((f) => f.params?.topic === "conversation/cli-sync-synced" && f.params.frame?.payload?.snapshot?.rows)
			.at(-1)?.params.frame.payload.snapshot;
		assert.equal(lastSnapshot?.config?.model, "deepseek-flash", "会话快照 config.model 应回读 deepseek-flash");
	} finally {
		b.child.kill();
		try {
			rmSync(modelsDir, { recursive: true, force: true });
		} catch {
			// Windows 句柄延迟释放时忽略；临时目录由系统清理。
		}
	}
});

test("cli-provider-sync：openai-responses 方言条目同名直通可用（mock 验证，R5 low⑭ 放开映射的前置）", async () => {
	const modelsDir = mkdtempSync(join(tmpdir(), "step-cli-provider-sync-"));
	const modelsFilePath = join(modelsDir, "models.json");
	writeModelsFile(modelsFilePath, { "my-responses-provider": responsesProviderEntry(DEEPSEEK_FIXTURE_KEY) });
	const b = launchBridge([], { STEP_MOCK_MODELS_FILE: modelsFilePath });
	try {
		await createAndSubscribe(b, "cli-sync-responses", 1);

		// set_model 选中 openai-responses 条目成功、回复行模型=条目模型 id
		// （mock 按调用读 models.json 合并条目，api 方言原样透传为 openai-responses）。
		const first = await sendCommand(b, 10, {
			commandId: "cli-sync-responses-send-1",
			sessionId: "cli-sync-responses",
			type: "sendText",
			payload: { text: "responses 方言首发", modelSelection: { providerId: "my-responses-provider", modelId: "resp-test-1" } },
		});
		assert.equal(first.result?.status, "accepted", `openai-responses 条目模型选择不应报错：${first.error?.message}`);
		const reply = await waitForAssistantReply(b, "cli-sync-responses", "responses 方言首发");
		assert.equal(reply.model, "resp-test-1", "回复行模型=条目里的 resp-test-1（底座真实模型）");
	} finally {
		b.child.kill();
		try {
			rmSync(modelsDir, { recursive: true, force: true });
		} catch {
			// Windows 句柄延迟释放时忽略；临时目录由系统清理。
		}
	}
});

test("cli-provider-sync：条目 apiKey 为空 → 仍 Model not found（凭据门控，条目存在≠可用）", async () => {
	const modelsDir = mkdtempSync(join(tmpdir(), "step-cli-provider-sync-"));
	const modelsFilePath = join(modelsDir, "models.json");
	// 条目存在但 apiKey 为空：镜像真实 CLI 的 available 过滤——无凭据的 provider 整体不可用。
	writeModelsFile(modelsFilePath, { deepseek: deepseekProviderEntry(DEEPSEEK_EMPTY_KEY) });
	const b = launchBridge([], { STEP_MOCK_MODELS_FILE: modelsFilePath });
	try {
		await createAndSubscribe(b, "cli-sync-empty-key", 1);

		const failure = await sendCommand(b, 10, {
			commandId: "cli-sync-empty-key-send-1",
			sessionId: "cli-sync-empty-key",
			type: "sendText",
			payload: { text: "空 Key 不该发出", modelSelection: { providerId: "deepseek", modelId: "deepseek-flash" } },
		});
		assert.ok(failure.error, "空 apiKey 条目不得被当作可用供应商");
		assert.ok(
			typeof failure.error.message === "string" && failure.error.message.includes("Model not found: deepseek/deepseek-flash"),
			`错误应仍为 Model not found（凭据门控），实际：${failure.error?.message}`,
		);
		// 消息未发出。
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.ok(
			!snapshotRows(b, "cli-sync-empty-key").some((r) => JSON.stringify(r).includes("空 Key 不该发出")),
			"被拒消息不得出现在会话行里",
		);
	} finally {
		b.child.kill();
		try {
			rmSync(modelsDir, { recursive: true, force: true });
		} catch {
			// Windows 句柄延迟释放时忽略；临时目录由系统清理。
		}
	}
});

test("cli-provider-sync：晚绑定——会话中途写入条目后下一次发送成功（mock 按调用读文件，『先同步后 spawn』时序可观测）", async () => {
	const modelsDir = mkdtempSync(join(tmpdir(), "step-cli-provider-sync-"));
	const modelsFilePath = join(modelsDir, "models.json");
	// env 指向的文件初始不存在：mock 惰性读取回落基础清单（与未同步同观感）。
	const b = launchBridge([], { STEP_MOCK_MODELS_FILE: modelsFilePath });
	try {
		await createAndSubscribe(b, "cli-sync-late-bind", 1);

		// 前置：文件缺失时 deepseek 仍不可选。
		const beforeSync = await sendCommand(b, 10, {
			commandId: "cli-sync-late-send-1",
			sessionId: "cli-sync-late-bind",
			type: "sendText",
			payload: { text: "同步前首发", modelSelection: { providerId: "deepseek", modelId: "deepseek-flash" } },
		});
		assert.ok(beforeSync.error, "文件缺失时模型选择必须失败（回落基础清单）");

		// 会话中途写入同步条目（宿主侧读-合并-写的测试侧替身；真实时序=spawn 前同步）。
		writeModelsFile(modelsFilePath, { deepseek: deepseekProviderEntry(DEEPSEEK_FIXTURE_KEY) });

		// 下一次发送（同一会话、同一模型选择）成功——mock 按调用读文件，时序可观测。
		const afterSync = await sendCommand(b, 11, {
			commandId: "cli-sync-late-send-2",
			sessionId: "cli-sync-late-bind",
			type: "sendText",
			payload: { text: "同步后首发", modelSelection: { providerId: "deepseek", modelId: "deepseek-flash" } },
		});
		assert.ok(afterSync.result, `写入条目后同一模型选择应成功：${afterSync.error?.message}`);
		const reply = await waitForAssistantReply(b, "cli-sync-late-bind", "同步后首发");
		assert.equal(reply.model, "deepseek-flash", "晚绑定后回复行模型=deepseek-flash");
	} finally {
		b.child.kill();
		try {
			rmSync(modelsDir, { recursive: true, force: true });
		} catch {
			// Windows 句柄延迟释放时忽略；临时目录由系统清理。
		}
	}
});
