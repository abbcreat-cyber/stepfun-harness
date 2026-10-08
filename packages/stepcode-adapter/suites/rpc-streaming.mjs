/**
 * A2 一轮问答 + A3 流式增量：
 * 文本剧本（agent_start → user/assistant 消息对 → text_start/delta×N/end → agent_settled）
 * 与工具剧本（toolcall_start 附加 id/toolName、tool_execution_start/update/end 配对），
 * 外加 abort 中断当前轮。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mockClient, eventsOfType, indexOfEvent, sleep } from "./helpers.mjs";

test("A2: 一轮问答的完整事件序与增量拼接", async () => {
	const client = mockClient();
	try {
		await client.start();
		const events = await client.promptAndWait("hi", { timeoutMs: 10000 });

		// 顺序：agent_start < message_update(text_delta) < agent_settled
		const iStart = indexOfEvent(events, "agent_start");
		const iSettled = indexOfEvent(events, "agent_settled");
		const iFirstDelta = events.findIndex(
			(e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
		);
		assert.ok(iStart !== -1 && iSettled !== -1 && iFirstDelta !== -1, "缺少关键事件");
		assert.ok(iStart < iFirstDelta, "agent_start 应先于首个 text_delta");
		assert.ok(iFirstDelta < iSettled, "text_delta 应先于 agent_settled");

		// 增量条数与拼接结果
		const deltas = events.filter(
			(e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
		);
		assert.ok(deltas.length >= 3, `text_delta 应分多片到达（实际 ${deltas.length}）`);
		const joined = deltas.map((e) => e.assistantMessageEvent.delta).join("");
		assert.equal(joined, "mock reply to: hi");

		// message_update 的线上形状：usage + 剥掉 partial 的事件体
		assert.ok(deltas[0].usage && typeof deltas[0].usage === "object");
		assert.equal("partial" in deltas[0].assistantMessageEvent, false, "partial 快照应被剥掉");

		// message_end 覆盖 user + assistant
		const messageEnds = eventsOfType(events, "message_end");
		assert.ok(messageEnds.length >= 2);
		const assistantEnd = messageEnds.find((e) => e.message?.role === "assistant");
		assert.ok(assistantEnd, "缺少 assistant 的 message_end");
		assert.equal(assistantEnd.message.content[0].text, "mock reply to: hi");

		// 收尾
		const agentEnd = eventsOfType(events, "agent_end").at(-1);
		assert.equal(agentEnd.willRetry, false);
	} finally {
		await client.stop();
	}
});

test("A2: prompt 失败剧本返回 success:false 的错误响应", async () => {
	const client = mockClient();
	try {
		await client.start();
		await assert.rejects(() => client.prompt("mock:error"), /No API key found for mock-provider/);
	} finally {
		await client.stop();
	}
});

test("A3: 工具调用流（toolcall 事件带 id/toolName，tool_execution 配对）", async () => {
	const client = mockClient();
	try {
		await client.start();
		const events = await client.promptAndWait("mock:tool", { timeoutMs: 10000 });

		const toolcallStart = events.find(
			(e) => e.type === "message_update" && e.assistantMessageEvent?.type === "toolcall_start",
		);
		assert.ok(toolcallStart, "缺少 toolcall_start");
		// json-event.ts:23-30：toolcall_start 附加 id 与 toolName
		assert.equal(toolcallStart.assistantMessageEvent.id, "call_mock_1");
		assert.equal(toolcallStart.assistantMessageEvent.toolName, "bash");

		const toolcallDelta = events.find(
			(e) => e.type === "message_update" && e.assistantMessageEvent?.type === "toolcall_delta",
		);
		assert.ok(toolcallDelta, "缺少 toolcall_delta");
		const toolcallEnd = events.find(
			(e) => e.type === "message_update" && e.assistantMessageEvent?.type === "toolcall_end",
		);
		assert.ok(toolcallEnd, "缺少 toolcall_end");
		assert.equal(toolcallEnd.assistantMessageEvent.toolCall.id, "call_mock_1");

		const execStart = eventsOfType(events, "tool_execution_start")[0];
		const execUpdate = eventsOfType(events, "tool_execution_update")[0];
		const execEnd = eventsOfType(events, "tool_execution_end")[0];
		assert.ok(execStart && execUpdate && execEnd, "tool_execution 三段应齐全");
		assert.equal(execStart.toolCallId, "call_mock_1");
		assert.equal(execStart.toolName, "bash");
		assert.deepEqual(execStart.args, { command: "echo mock" });
		assert.equal(execUpdate.toolCallId, execStart.toolCallId);
		assert.equal(execEnd.toolCallId, execStart.toolCallId);
		assert.equal(execEnd.isError, false);

		// 顺序：toolcall_end < tool_execution_start < tool_execution_end < settled
		const order = (predicate) => events.findIndex(predicate);
		assert.ok(order((e) => e.type === "message_update" && e.assistantMessageEvent?.type === "toolcall_end") < indexOfEvent(events, "tool_execution_start"));
		assert.ok(indexOfEvent(events, "tool_execution_start") < indexOfEvent(events, "tool_execution_end"));
		assert.ok(indexOfEvent(events, "tool_execution_end") < indexOfEvent(events, "agent_settled"));
	} finally {
		await client.stop();
	}
});

test("A5(前置): abort 中断等待批准的轮次并收敛到 agent_settled", async () => {
	const client = mockClient();
	try {
		await client.start();
		// handler 永不返回：mock 会停在等待 extension_ui_response。
		client.handleUiRequests(() => new Promise(() => {}));

		const eventsPromise = client.collectEvents(10000);
		await client.prompt("mock:confirm");
		await sleep(150); // 等 mock 发出 confirm 请求并进入等待
		await client.abort();
		const events = await eventsPromise;

		const execEnd = eventsOfType(events, "tool_execution_end")[0];
		assert.ok(execEnd, "abort 后应有拒绝分支的 tool_execution_end");
		assert.equal(execEnd.isError, true);
		assert.ok(events.some((e) => e.type === "agent_settled"), "abort 后必须收敛到 agent_settled");
	} finally {
		await client.stop();
	}
});
