/**
 * P0-05 协议级模式分支与 input/select 往返（handler = 桥接 permission，驱动真实 mock）。
 *
 * 与 suites/permission-drafts.mjs（单元级策略）与 rpc-approval.mjs（裸 client 批准往返）
 * 的分工：本套件把 bridge.permission 直接挂成 UI handler，经 stdio mock 验证
 * 「模式分支第一次到达协议级」——yolo 放行→工具真执行；plan→isError 且 mock 侧
 * 走 deny 剧本（评审指出的盲区）。另覆盖 mock:input / mock:select 剧本的
 * value/cancelled 语义（对齐 rpc-mode.ts:147-153：cancelled 或无 value 均得 undefined）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mockClient, eventsOfType } from "./helpers.mjs";
import { createWorkflowBridge } from "../src/workflow/bridge.mjs";

const makeBridge = (mode) =>
	createWorkflowBridge({ root: "unused", session: () => ({ mode }), rows: () => [], changed() {}, completed() {} });

const lastAssistantText = (events) => {
	const messages = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
	return String(messages.at(-1)?.message?.content?.find((block) => block.type === "text")?.text ?? "");
};

test("protocol: bridge yolo mode auto-allows native tool permission — tool really executes", async () => {
	const bridge = makeBridge("yolo");
	const client = mockClient([], { onUiRequest: (request) => bridge.permission("s", request) });
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		await client.promptAndWait("mock:confirm", { timeoutMs: 10000 });
		const execEnd = eventsOfType(events, "tool_execution_end")[0];
		assert.equal(execEnd.isError, false, "yolo 放行后工具应真执行");
		assert.equal(bridge.snapshot("s").pendingInteractions.length, 0, "yolo 不产生弹窗");
		assert.match(lastAssistantText(events), /Tool finished/);
	} finally {
		await client.stop();
		await bridge.close();
	}
});

test("protocol: bridge plan mode denies native tool permission — isError, mock denial copy, no pending", async () => {
	const bridge = makeBridge("plan");
	const client = mockClient([], { onUiRequest: (request) => bridge.permission("s", request) });
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		await client.promptAndWait("mock:confirm", { timeoutMs: 10000 });
		const execEnd = eventsOfType(events, "tool_execution_end")[0];
		assert.equal(execEnd.isError, true, "plan 拒绝后工具结果应为错误");
		assert.equal(bridge.snapshot("s").pendingInteractions.length, 0, "plan 拒绝不建弹窗");
		assert.match(lastAssistantText(events), /Tool was denied by the user\./, "mock 走 deny 剧本文案");
		assert.ok(events.some((e) => e.type === "agent_settled"), "轮次收敛");
	} finally {
		await client.stop();
		await bridge.close();
	}
});

test("protocol: mock:input roundtrip — request carries title/message/placeholder; {value} answer reaches the backend", async () => {
	const client = mockClient([], { onUiRequest: async () => ({ value: "feat/login" }) });
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		await client.promptAndWait("mock:input", { timeoutMs: 10000 });
		const request = eventsOfType(events, "extension_ui_request").find((e) => e.method === "input");
		assert.ok(request, "应有 input 扩展 UI 请求");
		assert.equal(request.title, "分支名");
		assert.equal(request.message, "请输入要创建的分支名");
		assert.equal(request.placeholder, "feat/x");
		assert.match(lastAssistantText(events), /feat\/login/, "handler 的 value 应到达底座侧结果");
	} finally {
		await client.stop();
	}
});

test("protocol: mock:input with {cancelled:true} — backend gets undefined and the turn still settles", async () => {
	const client = mockClient([], { onUiRequest: () => ({ cancelled: true }) });
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		await client.promptAndWait("mock:input", { timeoutMs: 10000 });
		assert.match(lastAssistantText(events), /Input cancelled/, "cancelled 时底座侧收到 undefined");
		assert.ok(events.some((e) => e.type === "agent_settled"), "轮次收敛");
	} finally {
		await client.stop();
	}
});

test("protocol: mock:select roundtrip — options reach the client; {value} answer reaches the backend", async () => {
	const client = mockClient([], { onUiRequest: async () => ({ value: "prod" }) });
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		await client.promptAndWait("mock:select", { timeoutMs: 10000 });
		const request = eventsOfType(events, "extension_ui_request").find((e) => e.method === "select");
		assert.ok(request, "应有 select 扩展 UI 请求");
		assert.deepEqual(request.options, ["staging", "prod"]);
		assert.match(lastAssistantText(events), /prod/, "handler 的 value 应到达底座侧结果");
	} finally {
		await client.stop();
	}
});

test("protocol: mock:select with {cancelled:true} — backend gets undefined and the turn still settles", async () => {
	const client = mockClient([], { onUiRequest: () => ({ cancelled: true }) });
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		await client.promptAndWait("mock:select", { timeoutMs: 10000 });
		assert.match(lastAssistantText(events), /Selection cancelled/, "cancelled 时底座侧收到 undefined");
		assert.ok(events.some((e) => e.type === "agent_settled"), "轮次收敛");
	} finally {
		await client.stop();
	}
});
