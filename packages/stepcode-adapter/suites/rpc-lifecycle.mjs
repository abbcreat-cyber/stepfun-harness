/**
 * A5：异常退出与错误传播。
 * 覆盖：stdin EOF 优雅退出（exit 0）、SIGINT 模拟（exit 130）、崩溃（exit 1）时
 * pending 请求全部 reject、非法 JSON 行的 parse 错误响应、spawn 失败、
 * stop() 的 kill 兜底、stop 幂等与停止后状态。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mockClient, eventsOfType } from "./helpers.mjs";

test("A5a: stdin EOF → mock flush 后 exit 0，stop() 返回退出信息", async () => {
	const client = mockClient();
	try {
		await client.start();
		await client.promptAndWait("hi", { timeoutMs: 10000 }); // 先跑一轮，确保有状态要冲刷

		const info = await client.stop();
		assert.equal(info.code, 0);
		assert.equal(info.signal, null);
		assert.equal(client.isRunning(), false);
	} finally {
		await client.stop(); // 幂等
	}
});

test("A5a: stop 后再发命令报错，重复 stop 不抛", async () => {
	const client = mockClient();
	await client.start();
	await client.stop();
	await client.stop();
	await assert.rejects(() => client.getState(), /Client not started/);
});

test("A5b: 模拟 SIGINT（exit 130）——退出码传播、后续请求被 exitError 拒绝", async () => {
	const client = mockClient();
	try {
		await client.start();
		await client.prompt("mock:exit130"); // mock 回 prompt success 后 exit(130)

		const info = await client.waitForExit(5000);
		assert.equal(info.code, 130);

		await assert.rejects(() => client.getState(), /exited \(code=130/);
	} finally {
		await client.stop();
	}
});

for (const exit of ["exit130", "crash"]) test(`A5: ${exit} immediately rejects active idle/event waits and releases handlers`, async () => {
  const client = mockClient();
  try {
    await client.start();
    const events = client.collectEvents(60_000), idle = client.waitForIdle(60_000);
    const eventsRejected = assert.rejects(events, /process exited|process.*error/);
    const idleRejected = assert.rejects(idle, /process exited|process.*error/);
    await client.prompt(`mock:${exit}`).catch(() => {});
    await Promise.all([eventsRejected, idleRejected]);
    assert.equal(client.eventListeners.length, 0);
    assert.equal(client.failureListeners.length, 0);
    await assert.rejects(client.collectEvents(60_000), /process exited|process.*error/);
    assert.equal(client.eventListeners.length, 0);
  } finally { await client.stop(); }
});

test("A5: aborted collector removes both event and lifecycle handlers", async () => {
  const client = mockClient();
  try {
    await client.start();
    const controller = new AbortController();
    const events = client.collectEvents(60_000, { signal: controller.signal });
    const rejected = assert.rejects(events, /cancelled/);
    controller.abort(); await rejected;
    assert.equal(client.eventListeners.length, 0); assert.equal(client.failureListeners.length, 0);
  } finally { await client.stop(); }
});

test("A5d: 模拟崩溃（exit 1）——挂起请求全部 reject，stderr 可见", async () => {
	const client = mockClient(["--hang", "get_state"]);
	try {
		await client.start();

		const pendingState = client.getState(); // 会挂住（--hang）
		const pendingState2 = client.request({ type: "get_state", id: "also-hanging" }); // 同样挂住
		await new Promise((resolve) => setTimeout(resolve, 100));
		const promptResult = client.prompt("mock:crash"); // 不回响应即崩溃

		const info = await client.waitForExit(5000);
		assert.equal(info.code, 1);

		await assert.rejects(() => pendingState, /exited \(code=1/);
		await assert.rejects(() => pendingState2, /exited \(code=1/);
		await assert.rejects(() => promptResult, /exited \(code=1/);
		assert.match(client.getStderr(), /simulated crash/);
	} finally {
		await client.stop();
	}
});

test("A5c: 非法 JSON 行 → command:parse 错误响应（无 id，经事件流广播）", async () => {
	const client = mockClient();
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		client.writeRawLine("{oops");
		await new Promise((resolve) => setTimeout(resolve, 300));

		const parseResponses = events.filter((e) => e.type === "response" && e.command === "parse");
		assert.equal(parseResponses.length, 1);
		assert.equal(parseResponses[0].success, false);
		assert.match(parseResponses[0].error, /Failed to parse command/);
		assert.equal("id" in parseResponses[0], false, "parse 错误响应不带 id");

		// 通道仍然健康
		const state = await client.getState();
		assert.equal(state.isStreaming, false);
	} finally {
		await client.stop();
	}
});

test("A5: spawn 失败（可执行不存在）在 start() 即刻拒绝", async () => {
	const { StepCodeRpcClient } = await import("../src/rpc-client.mjs");
	const client = new StepCodeRpcClient({
		command: ["definitely-missing-executable-xyz", "--mode", "rpc"],
	});
	await assert.rejects(() => client.start(), /Failed to spawn step process/);
	await client.stop(); // 不应抛
});

test("A5: --ignore-eof 卡死进程走 SIGTERM/SIGKILL 兜底", async () => {
	const client = mockClient(["--ignore-eof"]);
	await client.start();
	const info = await client.stop({ timeoutMs: 300 });
	assert.equal(client.isRunning(), false);
	// Windows 上 kill() 后 exit code 通常为 1；Unix 为 null+signal。两者都算"已死"。
	assert.ok(
		(info.code === null && info.signal !== null) || (info.code !== null && info.code !== 0),
		`应报告非正常退出，实际 code=${info.code} signal=${info.signal}`,
	);
});

test("A5: stop() 时仍在挂起的请求被 reject", async () => {
	const client = mockClient(["--hang", "get_state"]);
	try {
		await client.start();
		const pending = client.getState();
		await new Promise((resolve) => setTimeout(resolve, 100));
		await client.stop();
		// 优雅 stop 会先触发进程退出：挂起请求被 exit 错误 reject；若进程未及时退则被 Client stopped reject。
		await assert.rejects(() => pending, /exited \(code=0|Client stopped/);
	} finally {
		await client.stop();
	}
});

test("A5: 进程退出后 exitWaiters 立即返回缓存信息", async () => {
	const client = mockClient();
	await client.start();
	await client.promptAndWait("hi", { timeoutMs: 10000 });
	const first = await client.stop();
	const second = await client.waitForExit(1000);
	assert.deepEqual(second, first);
});

test("A5: 大事件量下严格 JSONL 不丢帧不串帧", async () => {
	const client = mockClient(["--delay", "0"]);
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		const long = `x`.repeat(5000); // 长 message → 多个 text_delta 分片
		await client.promptAndWait(`hi ${long}`, { timeoutMs: 15000 });
		const deltas = events.filter(
			(e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
		);
		const joined = deltas.map((e) => e.assistantMessageEvent.delta).join("");
		assert.equal(joined, `mock reply to: hi ${long}`);
		assert.ok(deltas.length >= 100, `应有大量增量分片（实际 ${deltas.length}）`);
	} finally {
		await client.stop();
	}
});
