/**
 * A4：工具批准往返（extension_ui_request ↔ extension_ui_response）。
 * 覆盖：allow / deny / cancelled / handler 抛错（fail-closed）/ 无 handler 默认拒绝、
 * 批准期间事件流不断（bash_execution_update 持续到达）、请求与响应 id 配对、
 * 手动 respondUiRequest 模式与幂等去重、mock 侧超时默认拒绝。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mockClient, eventsOfType, indexOfEvent } from "./helpers.mjs";

test("A4: handler 放行（confirmed:true）——工具执行、id 配对、批准期间事件流不断", async () => {
	const client = mockClient();
	const events = [];
	client.onEvent((e) => events.push(e));
	/** @type {any[]} */
	const seenRequests = [];
	client.handleUiRequests(async (req) => {
		seenRequests.push(req);
		// 故意延迟批准：让 mock 的等待期有足够时间持续发增量事件。
		await new Promise((resolve) => setTimeout(resolve, 200));
		return { confirmed: true };
	});
	try {
		await client.start();
		await client.promptAndWait("mock:confirm", { timeoutMs: 10000 });

		// 请求到达且形状正确（P0-05 起对齐底座真实后缀形状：call id 后 8 位做弹窗键、
		// Call: <id>\n<参数 JSON>——isNativeToolPermission 双正则可命中，四模式策略
		// 才能在协议级测到真分支）。
		const uiRequests = eventsOfType(events, "extension_ui_request").filter((e) => e.method === "confirm");
		assert.equal(uiRequests.length, 1);
		const req = uiRequests[0];
		assert.match(req.title, /^Approve bash \[l_mock_1\]$/);
		assert.match(req.message, /^Call: call_mock_1\r?\n\{"command":"echo mock"\}$/);
		assert.equal(typeof req.id, "string");

		// handler 看到的与事件流里的同一个 id（配对）
		assert.equal(seenRequests.length, 1);
		assert.equal(seenRequests[0].id, req.id);

		// 批准期间事件流不断：waiting 增量夹在 confirm 请求与 tool_execution_start 之间
		const iReq = events.indexOf(req);
		const iExecStart = indexOfEvent(events, "tool_execution_start");
		const waitingDeltas = events
			.filter((e) => e.type === "bash_execution_update" && String(e.delta).includes("waiting"))
			.map((e) => events.indexOf(e));
		assert.ok(waitingDeltas.length >= 1, "等待批准期间应有 bash_execution_update 增量");
		assert.ok(waitingDeltas.every((index) => index > iReq), "waiting 增量应在 confirm 请求之后");
		assert.ok(waitingDeltas.every((index) => index < iExecStart), "waiting 增量应在 tool_execution_start 之前");

		const execEnd = eventsOfType(events, "tool_execution_end")[0];
		assert.equal(execEnd.isError, false);
		assert.ok(events.some((e) => e.type === "agent_settled"));
	} finally {
		await client.stop();
	}
});

test("A4: handler 拒绝（confirmed:false）——工具被拒、assistant 说明、轮次收敛", async () => {
	const client = mockClient();
	const events = [];
	client.onEvent((e) => events.push(e));
	client.handleUiRequests(() => ({ confirmed: false }));
	try {
		await client.start();
		await client.promptAndWait("mock:confirm", { timeoutMs: 10000 });
		const execEnd = eventsOfType(events, "tool_execution_end")[0];
		assert.equal(execEnd.isError, true);
		const denial = events.find(
			(e) => e.type === "message_end" && e.message?.role === "assistant" && String(e.message.content?.[0]?.text ?? "").includes("denied"),
		);
		assert.ok(denial, "拒绝后应有说明文本");
		assert.ok(events.some((e) => e.type === "agent_settled"));
	} finally {
		await client.stop();
	}
});

test("A4: handler 返回 cancelled:true 走同一拒绝分支", async () => {
	const client = mockClient();
	const events = [];
	client.onEvent((e) => events.push(e));
	client.handleUiRequests(() => ({ cancelled: true }));
	try {
		await client.start();
		await client.promptAndWait("mock:confirm", { timeoutMs: 10000 });
		assert.equal(eventsOfType(events, "tool_execution_end")[0].isError, true);
	} finally {
		await client.stop();
	}
});

test("A4: handler 抛错按 fail-closed 取消处理", async () => {
	const client = mockClient();
	const events = [];
	client.onEvent((e) => events.push(e));
	client.handleUiRequests(() => {
		throw new Error("boom");
	});
	try {
		await client.start();
		await client.promptAndWait("mock:confirm", { timeoutMs: 10000 });
		assert.equal(eventsOfType(events, "tool_execution_end")[0].isError, true);
		assert.match(client.getStderr(), /ui handler error: boom/);
	} finally {
		await client.stop();
	}
});

test("A4: 未注册 handler 时默认自动回 cancelled（fail-closed）", async () => {
	const client = mockClient();
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		await client.promptAndWait("mock:confirm", { timeoutMs: 10000 });
		assert.equal(eventsOfType(events, "tool_execution_end")[0].isError, true, "默认应拒绝");
	} finally {
		await client.stop();
	}
});

test("A4: 手动模式（manualUiResponses）+ respondUiRequest 放行，重复响应被忽略", async () => {
	const client = mockClient([], { manualUiResponses: true });
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		const settled = client.waitForIdle(10000);
		// R5 评审 low：settled 预挂兜底 catch——若下方轮询先超时红，本 promise 无人
		// await，waitForIdle 随后的超时 reject 会以 unhandledRejection 顶替轮询超时
		// 的取证错误；预挂 catch 只吞这条无人接管的分支，settled 真失败时下方
		// await settled 仍照常抛出。
		settled.catch(() => {});
		await client.prompt("mock:confirm");

		// 有界轮询（R4 low ⑧）：请求永不到达时按 deadline 拒绝，抛可诊断错误而非无限空转。
		const req = await new Promise((resolve, reject) => {
			const found = eventsOfType(events, "extension_ui_request").find((e) => e.method === "confirm");
			if (found) {
				resolve(found);
				return;
			}
			const deadline = Date.now() + 10000;
			const timer = setInterval(() => {
				const hit = eventsOfType(events, "extension_ui_request").find((e) => e.method === "confirm");
				if (hit) {
					clearInterval(timer);
					resolve(hit);
				} else if (Date.now() >= deadline) {
					clearInterval(timer);
					const seenTypes = [...new Set(events.map((e) => e.type))].join(",") || "(无)";
					reject(
						new Error(
							`等待 extension_ui_request(confirm) 超时（10000ms）；已见事件类型：${seenTypes}；stderr：${client.getStderr()}`,
						),
					);
				}
			}, 20);
		});

		client.respondUiRequest(req.id, { confirmed: true });
		client.respondUiRequest(req.id, { confirmed: false }); // 幂等：第二个响应应被忽略
		await settled;

		assert.equal(eventsOfType(events, "tool_execution_end")[0].isError, false, "首次响应（放行）生效");
	} finally {
		await client.stop();
	}
});

test("A4: 宿主不响应时 mock 按超时默认拒绝（confirm-timeout 剧本）", async () => {
	const client = mockClient([], { manualUiResponses: true }); // 不回任何 UI 响应
	const events = [];
	client.onEvent((e) => events.push(e));
	try {
		await client.start();
		await client.promptAndWait("mock:confirm-timeout", { timeoutMs: 10000 });

		const req = eventsOfType(events, "extension_ui_request").find((e) => e.method === "confirm");
		assert.ok(req, "应有 confirm 请求");
		assert.equal(req.timeout, 250, "超时剧本应带 timeout 字段");
		assert.equal(eventsOfType(events, "tool_execution_end")[0].isError, true, "超时默认拒绝");
		// 等待期间事件流仍不断
		assert.ok(
			events.some((e) => e.type === "bash_execution_update" && String(e.delta).includes("waiting")),
			"超时等待期间应有增量事件",
		);
	} finally {
		await client.stop();
	}
});
