/**
 * input/select 扩展 UI 交互 → userInput pending 的桥接语义（P0-05）。
 *
 * 覆盖：
 * - prompt 折叠 title+message（+placeholder）——弹窗只有 prompt 一个文本字段，
 *   正文在 message，只透传 title 会丢正文（评审指出的丢字段）。
 * - select options 映射 {optionId,label}；空 options 直接 {cancelled:true}。
 * - resolve 的 value 语义：input 答案取 freeText、select 答案取 optionId → {value}。
 * - 四路兜底成 {cancelled:true}：answer 缺字段 / cancelPending / abort / close()
 *   （close 是评审指出的第四路）。
 * - pending 条目经 @zcode/shared conversationSnapshotSchema 校验（UI 零改动前提：
 *   payload 必须走得通宿主 zod schema）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowBridge } from "../src/workflow/bridge.mjs";
import { makeConversationSnapshot } from "../src/wire-shapes.mjs";
// shared 的 TS 源码树用 .js 后缀 import（惯例），纯 node 跨包直引会 ERR_MODULE_NOT_FOUND；
// 注册仓库自带 tsx loader（src/workflow/dependencies.mjs:2-3 的同款机制）后可加载 schema。
import { register } from "tsx/esm/api";
register();
const { conversationSnapshotSchema } = await import("@zcode/shared/zcode-protocol-v4");

const makeBridge = () =>
	createWorkflowBridge({ root: "unused", session: () => ({ mode: "build" }), rows: () => [], changed() {}, completed() {} });

/** 把 bridge.snapshot 包成可被宿主 schema 校验的完整 conversation snapshot。 */
function parseSnapshot(bridge, sessionId) {
	return conversationSnapshotSchema.parse(
		makeConversationSnapshot({ sessionId, logEpoch: "test", seq: 1, revision: 1, ...bridge.snapshot(sessionId) }),
	);
}

test("input pending: prompt folds title+message+placeholder; resolve freeText → {value}; passes host schema", async () => {
	const bridge = makeBridge();
	try {
		const waiting = bridge.permission("s", {
			method: "input",
			id: "in-1",
			title: "分支名",
			message: "请输入要创建的分支名",
			placeholder: "feat/x",
		});
		const snapshot = parseSnapshot(bridge, "s");
		const pending = snapshot.pendingInteractions[0];
		assert.ok(pending, "input 请求应建立 userInput pending");
		assert.equal(pending.kind, "userInput");
		assert.equal(pending.payload.kind, "userInput");
		assert.equal(pending.payload.freeText, true);
		assert.ok(pending.payload.prompt.includes("请输入要创建的分支名"), "prompt 必须含 message 正文（不只 title）");
		assert.ok(pending.payload.prompt.includes("分支名"), "prompt 含 title");
		assert.ok(pending.payload.prompt.includes("feat/x"), "placeholder 附在 prompt 里（弹窗只有一个文本字段）");
		bridge.resolve("s", pending.interactionId, { freeText: "feat/login" });
		assert.deepEqual(await waiting, { value: "feat/login" });
		assert.equal(bridge.snapshot("s").pendingInteractions.length, 0, "resolve 后 pending 清空");
	} finally {
		await bridge.close();
	}
});

test("select pending: options map to {optionId,label}; resolve optionId → {value}; passes host schema", async () => {
	const bridge = makeBridge();
	try {
		const waiting = bridge.permission("s", {
			method: "select",
			id: "sel-1",
			title: "部署环境",
			message: "请选择部署环境",
			options: ["staging", "prod"],
		});
		const snapshot = parseSnapshot(bridge, "s");
		const pending = snapshot.pendingInteractions[0];
		assert.ok(pending);
		assert.equal(pending.payload.freeText, false);
		assert.deepEqual(pending.payload.options, [
			{ optionId: "staging", label: "staging" },
			{ optionId: "prod", label: "prod" },
		]);
		assert.ok(pending.payload.prompt.includes("请选择部署环境"), "select prompt 同样折叠 message 正文");
		bridge.resolve("s", pending.interactionId, { optionId: "prod" });
		assert.deepEqual(await waiting, { value: "prod" });
	} finally {
		await bridge.close();
	}
});

test("select with empty options resolves {cancelled:true} immediately without pending", async () => {
	const bridge = makeBridge();
	try {
		const waiting = bridge.permission("s", { method: "select", id: "sel-0", title: "空选项", message: "无选项可选", options: [] });
		assert.deepEqual(await waiting, { cancelled: true });
		assert.equal(bridge.snapshot("s").pendingInteractions.length, 0);
	} finally {
		await bridge.close();
	}
});

test("answers missing the expected field fail closed to {cancelled:true} (input freeText / select optionId)", async () => {
	const bridge = makeBridge();
	try {
		// input：answer 缺 freeText / 空串
		let waiting = bridge.permission("s", { method: "input", id: "in-a", title: "t", message: "m" });
		let pending = bridge.snapshot("s").pendingInteractions[0];
		bridge.resolve("s", pending.interactionId, {});
		assert.deepEqual(await waiting, { cancelled: true });
		waiting = bridge.permission("s", { method: "input", id: "in-b", title: "t", message: "m" });
		pending = bridge.snapshot("s").pendingInteractions[0];
		bridge.resolve("s", pending.interactionId, undefined);
		assert.deepEqual(await waiting, { cancelled: true });
		// select：answer 缺 optionId（freeText 不顶用）
		waiting = bridge.permission("s", { method: "select", id: "sel-a", title: "t", message: "m", options: ["a"] });
		pending = bridge.snapshot("s").pendingInteractions[0];
		bridge.resolve("s", pending.interactionId, { freeText: "a" });
		assert.deepEqual(await waiting, { cancelled: true });
	} finally {
		await bridge.close();
	}
});

test("cancelPending and abort both coerce pending userInput to {cancelled:true}", async () => {
	const bridge = makeBridge();
	try {
		let waiting = bridge.permission("s", { method: "input", id: "in-1", title: "t", message: "m" });
		bridge.cancelPending("s");
		assert.deepEqual(await waiting, { cancelled: true });
		const controller = new AbortController();
		waiting = bridge.permission("s", { method: "select", id: "sel-1", title: "t", message: "m", options: ["a", "b"] }, controller.signal);
		controller.abort();
		assert.deepEqual(await waiting, { cancelled: true });
		assert.equal(bridge.snapshot("s").pendingInteractions.length, 0);
	} finally {
		await bridge.close();
	}
});

test("close() with a pending userInput resolves it as {cancelled:true} (fourth teardown path)", async () => {
	const bridge = makeBridge();
	const waiting = bridge.permission("s", { method: "input", id: "in-1", title: "t", message: "m" });
	assert.equal(bridge.snapshot("s").pendingInteractions.length, 1);
	await bridge.close();
	assert.deepEqual(await waiting, { cancelled: true });
});

test("editor requests stay fail-closed (no prefill/multiline dialog in UI)", async () => {
	const bridge = makeBridge();
	try {
		const waiting = bridge.permission("s", { method: "editor", id: "ed-1", title: "t", prefill: "x" });
		assert.deepEqual(await waiting, { cancelled: true });
		assert.equal(bridge.snapshot("s").pendingInteractions.length, 0);
	} finally {
		await bridge.close();
	}
});
