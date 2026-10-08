/**
 * A1：握手（rpc 模式无握手——spawn 后立即可发命令）与命令往返。
 * 覆盖：get_state 首条即发、id 关联回显与并发不串、模型命令、会话读取命令、
 * 未知命令错误、bash 命令与 bash_execution_update 事件、请求超时、new_session。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mockClient, collector, eventsOfType } from "./helpers.mjs";

test("A1: spawn 后无需握手，首条命令即可往返（get_state）", async () => {
	const client = mockClient();
	try {
		await client.start();
		const state = await client.getState();
		assert.equal(state.model.provider, "step");
		assert.equal(state.model.id, "step-5-preview");
		assert.equal(state.isStreaming, false);
		assert.equal(state.messageCount, 0);
		assert.equal(typeof state.sessionId, "string");
		assert.ok(state.sessionId.length > 0);
		assert.equal(state.steeringMode, "all");
	} finally {
		await client.stop();
	}
});

test("A1: 调用方自带 id 会被响应回显", async () => {
	const client = mockClient();
	try {
		await client.start();
		const response = await client.request({ type: "get_state", id: "custom-1" });
		assert.equal(response.id, "custom-1");
		assert.equal(response.success, true);
	} finally {
		await client.stop();
	}
});

test("A1: 并发请求按 id 配对，不串响应", async () => {
	const client = mockClient();
	try {
		await client.start();
		const [a, b] = await Promise.all([
			client.request({ type: "get_state", id: "pa" }),
			client.request({ type: "get_state", id: "pb" }),
		]);
		assert.equal(a.id, "pa");
		assert.equal(b.id, "pb");
	} finally {
		await client.stop();
	}
});

test("A1: get_available_models / set_model 成功与失败路径", async () => {
	const client = mockClient();
	try {
		await client.start();
		const models = await client.getAvailableModels();
		assert.equal(models.length, 2);
		assert.ok(models.some((m) => m.provider === "step" && m.id === "step-5-preview"));

		const applied = await client.setModel("mock", "mock-mini");
		assert.equal(applied.id, "mock-mini");
		const state = await client.getState();
		assert.equal(state.model.id, "mock-mini");

		await assert.rejects(() => client.setModel("nope", "x"), /Model not found: nope\/x/);
	} finally {
		await client.stop();
	}
});

test("A1: thinking level 命令", async () => {
	const client = mockClient();
	try {
		await client.start();
		const levels = await client.getAvailableThinkingLevels();
		assert.ok(levels.includes("medium"));
		await client.setThinkingLevel("high");
		const state = await client.getState();
		assert.equal(state.thinkingLevel, "high");
		await assert.rejects(() => client.setThinkingLevel("ultra"), /Unknown thinking level: ultra/);
	} finally {
		await client.stop();
	}
});

test("A1: 空会话的 get_entries / get_tree / get_messages / get_last_assistant_text", async () => {
	const client = mockClient();
	try {
		await client.start();
		const entries = await client.getEntries();
		assert.deepEqual(entries.entries, []);
		assert.equal(entries.leafId, null);
		const tree = await client.getTree();
		assert.deepEqual(tree.tree, []);
		const messages = await client.getMessages();
		assert.deepEqual(messages, []);
		assert.equal(await client.getLastAssistantText(), null);
	} finally {
		await client.stop();
	}
});

test("A1: 一轮对话后 entries/messages 增长，get_last_assistant_text 可用", async () => {
	const client = mockClient();
	try {
		await client.start();
		await client.promptAndWait("hi", { timeoutMs: 10000 });

		const entries = await client.getEntries();
		assert.equal(entries.entries.length, 2); // user + assistant
		assert.equal(entries.leafId, entries.entries[1].id);

		const messages = await client.getMessages();
		assert.equal(messages.length, 2);
		assert.equal(messages[0].role, "user");
		assert.equal(messages[1].role, "assistant");

		assert.equal(await client.getLastAssistantText(), "mock reply to: hi");

		// since 增量读取
		const since = await client.getEntries(entries.entries[0].id);
		assert.equal(since.entries.length, 1);
		assert.equal(since.entries[0].id, entries.entries[1].id);
		await assert.rejects(() => client.getEntries("missing-entry"), /Entry not found: missing-entry/);
	} finally {
		await client.stop();
	}
});

test("A1: set_session_name 成功与空名报错", async () => {
	const client = mockClient();
	try {
		await client.start();
		await client.setSessionName("演示会话");
		const state = await client.getState();
		assert.equal(state.sessionName, "演示会话");
		await assert.rejects(() => client.setSessionName("   "), /Session name cannot be empty/);
	} finally {
		await client.stop();
	}
});

test("A1: 未知命令返回结构化错误响应", async () => {
	const client = mockClient();
	try {
		await client.start();
		const response = await client.request({ type: "bogus", id: "u1" });
		assert.equal(response.success, false);
		assert.equal(response.command, "bogus");
		assert.match(response.error, /Unknown command: bogus/);
	} finally {
		await client.stop();
	}
});

test("A1: bash 命令返回 BashResult 并发 bash_execution_update 事件", async () => {
	const client = mockClient();
	const { events } = collector(client);
	try {
		await client.start();
		const result = await client.bash("echo hi");
		assert.equal(result.exitCode, 0);
		assert.equal(result.cancelled, false);
		assert.match(result.output, /echo hi/);
		assert.match(result.output, /mock stdout/);
		const updates = eventsOfType(events, "bash_execution_update");
		assert.equal(updates.length, 2);
	} finally {
		await client.stop();
	}
});

test("A1: get_commands 返回扩展命令", async () => {
	const client = mockClient();
	try {
		await client.start();
		const commands = await client.getCommands();
		assert.equal(commands.length, 1);
		assert.equal(commands[0].name, "mock-status");
		assert.equal(commands[0].source, "extension");
	} finally {
		await client.stop();
	}
});

test("A1: new_session 重置会话", async () => {
	const client = mockClient();
	try {
		await client.start();
		await client.promptAndWait("hi", { timeoutMs: 10000 });
		const before = await client.getState();
		assert.equal(before.messageCount, 2);

		const result = await client.newSession();
		assert.deepEqual(result, { cancelled: false });
		const after = await client.getState();
		assert.equal(after.messageCount, 0);
		assert.notEqual(after.sessionId, before.sessionId);
	} finally {
		await client.stop();
	}
});

test("A1: steer/follow_up 入队并广播 queue_update，clear_queue 取回", async () => {
	const client = mockClient();
	const { events } = collector(client);
	try {
		await client.start();
		await client.steer("change direction");
		await client.followUp("summarize after");
		const queueUpdates = eventsOfType(events, "queue_update");
		assert.equal(queueUpdates.length, 2);
		assert.deepEqual(queueUpdates[1].steering, ["change direction"]);
		assert.deepEqual(queueUpdates[1].followUp, ["summarize after"]);

		const cleared = await client.clearQueue();
		assert.deepEqual(cleared, { steering: ["change direction"], followUp: ["summarize after"] });
	} finally {
		await client.stop();
	}
});

test("A1: 请求超时被拒绝（--hang）", async () => {
	const client = mockClient(["--hang", "get_state"]);
	try {
		await client.start();
		await assert.rejects(
			() => client.request({ type: "get_state" }, { timeoutMs: 300 }),
			/Timeout waiting for response to get_state/,
		);
	} finally {
		await client.stop();
	}
});
