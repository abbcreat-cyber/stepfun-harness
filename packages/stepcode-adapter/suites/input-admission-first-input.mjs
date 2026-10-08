/**
 * input-admission-first-input 套件（P0-01 复现测试）：
 * v4 createSession.firstInput 必须走与 sendText 同一条真实发送路径。
 *
 * 依据 docs/step-input-admission-queue-spec.md：
 * - firstInput 空白无附件 → 建会话前拒绝（防草稿泄漏）。
 * - firstInput 存在 → 建会话后真实 client.prompt；ACK input=commandId、delivery=startNow。
 * - 失败分类：stepRejected 清理空草稿；stepTimeout/未打标（投递未知）不清理不重发。
 *
 * 全部用例走 bin/zcode-bridge.mjs 路由入口（与桌面壳真实派生路径一致）。
 * 状态目录由 helpers.launchBridge 经 --state-dir argv 下发并回传 b.stateDir。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchBridge } from "./helpers.mjs";

const PNG_A =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aj1sAAAAASUVORK5CYII=";

/** 向指定 sessionId 上传一张图并返回 attachmentRef。 */
async function uploadImage(b, sessionId, base64, fileName) {
	const bytes = Buffer.from(base64, "base64");
	const p = {
		sessionId,
		connectionId: `${sessionId}-c`,
		uploadId: `upload-${sessionId}`,
		fileName,
		mime: "image/png",
		totalBytes: bytes.length,
		totalChunks: 1,
		checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
	};
	let id = 100;
	b.send({ id, method: "v4/attachment/begin", params: p });
	assert.equal((await b.waitFor((f) => f.id === id)).result.state, "staging");
	b.send({ id: ++id, method: "v4/attachment/chunk", params: { ...p, chunkIndex: 0, dataBase64: base64 } });
	await b.waitFor((f) => f.id === id);
	b.send({ id: ++id, method: "v4/attachment/commit", params: p });
	const committed = await b.waitFor((f) => f.id === id);
	return committed.result.ref;
}

/** 取指定 conversation topic 上最后一个含 rows 的 snapshot。 */
function lastSnapshot(b, sessionId) {
	return b.frames
		.filter((f) => f.params?.topic === `conversation/${sessionId}` && f.params.frame?.payload?.snapshot?.rows)
		.at(-1)?.params.frame.payload.snapshot;
}

async function subscribeConversation(b, sessionId, id, connectionId) {
	b.send({
		id,
		method: "v4/conversation/subscribe",
		params: { topic: `conversation/${sessionId}`, connectionId, clientMode: "desktop-continuous" },
	});
	await b.waitFor((f) => f.id === id, { label: `订阅 conversation/${sessionId}` });
}

test("firstInput：无预热首条文字真实执行且 ACK 诚实（inputId=commandId, delivery=startNow）", async () => {
	const b = launchBridge();
	try {
		await subscribeConversation(b, "fi-text-session", 1, "fi-text-c");
		b.send({
			id: 2,
			method: "v4/command",
			params: {
				commandId: "fi-text",
				sessionId: "fi-text-session",
				type: "createSession",
				payload: { workspaceId: "ws", firstInput: { text: "你好，首条输入" } },
			},
		});
		const ack = await b.waitFor((f) => f.id === 2, { label: "createSession ack" });
		assert.equal(ack.result.status, "accepted");
		assert.equal(ack.result.result.type, "createSession");
		assert.deepEqual(ack.result.result.input, { delivery: "startNow", inputId: "fi-text" });
		const started = await b.waitFor(
			(f) => f.params?.type === "turn.started" && f.params.sessionId === "fi-text-session",
			{ label: "turn.started" },
		);
		assert.equal(started.params.payload.input, "你好，首条输入");
		await b.waitFor(
			() => lastSnapshot(b, "fi-text-session")?.rows?.window?.some((r) => r.kind === "assistantText"),
			{ timeoutMs: 20000, label: "终态 snapshot" },
		);
		const userRow = lastSnapshot(b, "fi-text-session").rows.window.find((r) => r.kind === "userInput");
		assert.equal(userRow.text, "你好，首条输入");
		assert.equal(userRow.sourceCommandId, "fi-text");
	} finally {
		b.child.kill();
	}
});

test("firstInput：纯图片空文本进入 RPC 并产出 userInput 附件行", async () => {
	const b = launchBridge();
	try {
		const ref = await uploadImage(b, "fi-img-session", PNG_A, "clipboard.png");
		await subscribeConversation(b, "fi-img-session", 50, "fi-img-c");
		b.send({
			id: 60,
			method: "v4/command",
			params: {
				commandId: "fi-img",
				sessionId: "fi-img-session",
				type: "createSession",
				payload: {
					workspaceId: "ws",
					firstInput: {
						text: "",
						attachments: [{ ref, fileName: "clipboard.png", mime: "image/png", bytes: Buffer.from(PNG_A, "base64").length }],
					},
				},
			},
		});
		const ack = await b.waitFor((f) => f.id === 60, { label: "createSession ack" });
		assert.equal(ack.result.status, "accepted");
		assert.deepEqual(ack.result.result.input, { delivery: "startNow", inputId: "fi-img" });
		await b.waitFor(
			() => lastSnapshot(b, "fi-img-session")?.rows?.window?.some((r) => r.kind === "assistantText"),
			{ timeoutMs: 20000, label: "纯图回合完成" },
		);
		const snap = lastSnapshot(b, "fi-img-session");
		const userRow = snap.rows.window.find((r) => r.kind === "userInput");
		assert.equal(userRow.attachments[0].ref, ref);
		assert.equal(userRow.sourceCommandId, "fi-img");
		const echo = snap.rows.window.find((r) => r.kind === "assistantText").text;
		assert.ok(echo.includes(PNG_A), "assistant echo 应包含图片 base64");
		assert.ok(echo.includes("image/png"), "assistant echo 应包含 MIME");
	} finally {
		b.child.kill();
	}
});

test("firstInput：图文混发 base64 与 MIME 进入 StepRPC", async () => {
	const b = launchBridge();
	try {
		const ref = await uploadImage(b, "fi-mix-session", PNG_A, "mixed.png");
		await subscribeConversation(b, "fi-mix-session", 50, "fi-mix-c");
		b.send({
			id: 60,
			method: "v4/command",
			params: {
				commandId: "fi-mix",
				sessionId: "fi-mix-session",
				type: "createSession",
				payload: {
					workspaceId: "ws",
					firstInput: {
						text: "mock:image-transport",
						attachments: [{ ref, fileName: "mixed.png", mime: "image/png", bytes: Buffer.from(PNG_A, "base64").length }],
					},
				},
			},
		});
		const ack = await b.waitFor((f) => f.id === 60, { label: "createSession ack" });
		assert.equal(ack.result.status, "accepted");
		assert.deepEqual(ack.result.result.input, { delivery: "startNow", inputId: "fi-mix" });
		await b.waitFor(
			() => lastSnapshot(b, "fi-mix-session")?.rows?.window?.some((r) => r.kind === "assistantText"),
			{ timeoutMs: 20000, label: "图文回合完成" },
		);
		const snap = lastSnapshot(b, "fi-mix-session");
		const userRow = snap.rows.window.find((r) => r.kind === "userInput");
		assert.equal(userRow.text, "mock:image-transport");
		assert.equal(userRow.attachments[0].ref, ref);
		const echo = snap.rows.window.find((r) => r.kind === "assistantText").text;
		assert.ok(echo.includes(PNG_A) && echo.includes("image/png"));
	} finally {
		b.child.kill();
	}
});

test("firstInput：空白无附件建会话前拒绝且不泄漏草稿（sessions-index 无新增）", async () => {
	const b = launchBridge();
	try {
		b.send({
			id: 1,
			method: "v4/conversation/subscribe",
			params: { topic: "sessions-index/ws-fi-blank", connectionId: "fi-blank-c", clientMode: "desktop-continuous" },
		});
		await b.waitFor((f) => f.id === 1, { label: "sessions-index 订阅" });
		b.send({
			id: 2,
			method: "v4/command",
			params: {
				commandId: "fi-blank",
				sessionId: "fi-blank-session",
				type: "createSession",
				payload: { workspaceId: "ws", firstInput: { text: "   " } },
			},
		});
		const rejected = await b.waitFor((f) => f.id === 2, { label: "空白首发应被拒" });
		assert.ok(rejected.error, "空白无附件的 firstInput 必须返回错误而非 accepted");
		// 不泄漏草稿：错误后 sessions-index 不出现本会话的 upsert，也没有 turn。
		await new Promise((r) => setTimeout(r, 1200));
		const upserts = b.frames.filter(
			(f) => f.params?.frame?.payload?.deltas?.some((d) => d.session?.sessionId === "fi-blank-session"),
		);
		assert.equal(upserts.length, 0, "被拒首发不得在 sessions-index 留下会话");
		assert.equal(b.frames.filter((f) => f.params?.type === "turn.started").length, 0);
	} finally {
		b.child.kill();
	}
});

test("firstInput：同 commandId 并发重试只执行一次（单次 turn.started，双 ACK 一致）", async () => {
	const b = launchBridge();
	try {
		const create = {
			method: "v4/command",
			params: {
				commandId: "fi-repeat",
				sessionId: null,
				type: "createSession",
				payload: { workspaceId: "ws", firstInput: { text: "只执行一次" } },
			},
		};
		b.send({ ...create, id: 1 });
		b.send({ ...create, id: 2 });
		const one = await b.waitFor((f) => f.id === 1, { label: "第一个 ack" });
		const two = await b.waitFor((f) => f.id === 2, { label: "第二个 ack" });
		assert.deepEqual(one.result, two.result);
		assert.deepEqual(one.result.result.input, { delivery: "startNow", inputId: "fi-repeat" });
		await b.waitFor((f) => f.params?.type === "turn.completed", { timeoutMs: 20000, label: "turn.completed" });
		assert.equal(b.frames.filter((f) => f.params?.type === "turn.started").length, 1, "同 commandId 并发重试只能有一个 turn");
	} finally {
		b.child.kill();
	}
});

test("firstInput：首发 preflight 失败（STEP_MOCK_PROMPT_ERROR→stepRejected）返回错误不伪造 accepted 且清理草稿", async () => {
	const b = launchBridge([], { STEP_MOCK_PROMPT_ERROR: "401 Unauthorized (simulated)" });
	try {
		b.send({
			id: 2,
			method: "v4/command",
			params: {
				commandId: "fi-err",
				sessionId: "fi-err-session",
				type: "createSession",
				payload: { workspaceId: "ws", firstInput: { text: "mock:error" } },
			},
		});
		const failed = await b.waitFor((f) => f.id === 2, { label: "首发失败响应" });
		assert.ok(failed.error, "preflight 失败必须返回错误，不得伪造 accepted");
		assert.match(failed.error.message, /API Key|发送失败/);
		// 台账/幂等：失败命令不留 accepted 记录。
		b.send({ id: 3, method: "v4/commands/query", params: { commands: [{ sessionId: "fi-err-session", commandId: "fi-err" }] } });
		const query = await b.waitFor((f) => f.id === 3, { label: "commands/query" });
		assert.equal(query.result.results[0].result, "unknown");
		// 清理空草稿（stepRejected 分支）：共享 sessions-index 落盘不再含该会话。
		const stateFile = JSON.parse(readFileSync(join(b.stateDir, "sessions-index.json"), "utf8"));
		const leaked = Object.values(stateFile.workspaces ?? {}).flat().filter((s) => s?.sessionId === "fi-err-session");
		assert.equal(leaked.length, 0, "stepRejected 后应清理空草稿会话摘要");
	} finally {
		b.child.kill();
	}
});

test("firstInput：超时失败不清理不重发（投递未知：草稿保留、无假 ACK、无残留队列项）", async () => {
	const b = launchBridge([], { STEP_MOCK_HANG_COMMAND: "prompt" });
	try {
		b.send({
			id: 1,
			method: "v4/command",
			params: {
				commandId: "fi-timeout",
				sessionId: "fi-timeout-session",
				type: "createSession",
				payload: { workspaceId: "ws", firstInput: { text: "会被挂起的首发" } },
			},
		});
		// rpc-client 默认 requestTimeoutMs=30000；知情接受约 30s 超时燃烧（spec §7.7）。
		const failed = await b.waitFor((f) => f.id === 1, { timeoutMs: 45000, label: "超时失败响应" });
		assert.ok(failed.error, "挂起的 prompt 必须超时报错，不得伪造 accepted");
		// 无假 ACK：commands/query 回 unknown。
		b.send({ id: 2, method: "v4/commands/query", params: { commands: [{ sessionId: "fi-timeout-session", commandId: "fi-timeout" }] } });
		const query = await b.waitFor((f) => f.id === 2, { label: "commands/query" });
		assert.equal(query.result.results[0].result, "unknown");
		// 草稿保留（投递未知不清理）：共享 sessions-index 落盘仍含该会话。
		const stateFile = JSON.parse(readFileSync(join(b.stateDir, "sessions-index.json"), "utf8"));
		const kept = Object.values(stateFile.workspaces ?? {}).flat().filter((s) => s?.sessionId === "fi-timeout-session");
		assert.equal(kept.length, 1, "stepTimeout/投递未知不得清理草稿");
		// 无 turn、无残留队列项。
		assert.equal(b.frames.filter((f) => f.params?.type === "turn.started").length, 0);
		await subscribeConversation(b, "fi-timeout-session", 4, "fi-timeout-cc");
		await b.waitFor(
			() => lastSnapshot(b, "fi-timeout-session") !== undefined,
			{ timeoutMs: 8000, label: "conversation snapshot" },
		);
		assert.equal(lastSnapshot(b, "fi-timeout-session").queue.items.length, 0, "台账不得残留队列项");
	} finally {
		b.child.kill();
	}
});
