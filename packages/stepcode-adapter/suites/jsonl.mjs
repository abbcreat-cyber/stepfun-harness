/**
 * JSONL 编解码单元测试（复刻 Step-Code rpc/jsonl.ts 的语义）：
 * LF-only 帧界、\r 容忍、跨 chunk 分帧、UTF-8 多字节跨 chunk、end 冲刷尾巴。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { attachJsonlLineReader, serializeJsonLine } from "../src/jsonl.mjs";

// U+2028/U+2029 是合法 JSON 字符串内容（readline 会误当行界，严格 JSONL 不得如此）。
const SEPARATOR_TEXT = `line${String.fromCodePoint(0x2028)}sep${String.fromCodePoint(0x2029)}end`;

/**
 * 有界等待流 'end'（R4 low ⑧，同 helpers.mjs waitForExit 的 settle 模式）：
 * once(stream,"end") 在流不结束时会永久挂起——超时 destroy 流并抛可诊断错误。
 * @param {import("node:stream").PassThrough} stream
 * @param {{ timeoutMs?: number, label?: string }} [options] label：超时错误里的用例标识。
 */
function waitForStreamEnd(stream, { timeoutMs = 5000, label = "jsonl 测试流" } = {}) {
	// 先查：已发出 'end' 的流不会再触发，直接返回（参照 waitForExit 的 exitCode 先查）。
	if (stream.readableEnded) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		/** @type {NodeJS.Timeout | undefined} */
		let timer;
		/** @param {() => void} outcome */
		const settle = (outcome) => {
			if (timer) clearTimeout(timer);
			stream.off("end", onEnd);
			stream.off("error", onError);
			outcome();
		};
		const onEnd = () => settle(() => resolve());
		const onError = (/** @type {Error} */ error) =>
			settle(() => reject(new Error(`waitForStreamEnd：流错误（${label}）: ${error.message}`)));
		timer = setTimeout(() => {
			settle(() => {
				try {
					stream.destroy();
				} catch {
					// 流可能刚好结束。
				}
				reject(new Error(`waitForStreamEnd 超时（${timeoutMs}ms，已 destroy）: ${label}`));
			});
		}, timeoutMs);
		stream.once("end", onEnd);
		stream.once("error", onError);
	});
}

test("serializeJsonLine 末尾补 LF", () => {
	assert.equal(serializeJsonLine({ a: 1 }), '{"a":1}\n');
	assert.equal(serializeJsonLine("x"), '"x"\n');
});

test("U+2028/U+2029 是合法 JSON 字符串内容，不拆帧", async () => {
	const value = { text: SEPARATOR_TEXT };
	const wire = serializeJsonLine(value);
	assert.ok(wire.includes("\n"));
	assert.equal(wire.split("\n").filter((line) => line.length > 0).length, 1);

	const lines = [];
	const stream = new PassThrough();
	const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
	stream.end(wire);
	await waitForStreamEnd(stream, { label: "U+2028/U+2029 不拆帧用例" });
	detach();
	assert.equal(lines.length, 1);
	assert.deepEqual(JSON.parse(lines[0]), value);
});

test("单 chunk 多行 + 行尾 \\r 容忍", async () => {
	const lines = [];
	const stream = new PassThrough();
	const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
	stream.write('{"a":1}\r\n{"b":2}\n{"c":3}');
	stream.end();
	await waitForStreamEnd(stream, { label: "单 chunk 多行 + \\r 容忍用例" });
	detach();
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("跨 chunk 半行拼接", async () => {
	const lines = [];
	const stream = new PassThrough();
	const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
	stream.write('{"a":');
	stream.write('1}\n{"b":');
	stream.write('2}\n');
	stream.end();
	await waitForStreamEnd(stream, { label: "跨 chunk 半行拼接用例" });
	detach();
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("流结束冲刷无尾换行的最后一段", async () => {
	const lines = [];
	const stream = new PassThrough();
	const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
	stream.write('{"a":1}\n{"tail":');
	stream.end(Buffer.from("true}"));
	await waitForStreamEnd(stream, { label: "结尾冲刷用例" });
	detach();
	assert.deepEqual(lines, ['{"a":1}', '{"tail":true}']);
});

test("UTF-8 多字节字符跨 Buffer chunk 不乱码", async () => {
	const payload = serializeJsonLine({ text: "你好，世界" });
	const bytes = Buffer.from(payload, "utf8");
	const half = Math.floor(bytes.length / 2);

	const lines = [];
	const stream = new PassThrough();
	const detach = attachJsonlLineReader(stream, (line) => lines.push(line));
	stream.write(bytes.subarray(0, half));
	stream.write(bytes.subarray(half));
	stream.end();
	await waitForStreamEnd(stream, { label: "UTF-8 跨 chunk 用例" });
	detach();

	assert.equal(lines.length, 1);
	assert.deepEqual(JSON.parse(lines[0]), { text: "你好，世界" });
});

test("successResponse：data === null 保留字段，仅 undefined 省略（对齐 rpc-mode.ts:69）", async () => {
	const { successResponse } = await import("../src/rpc-protocol.mjs");
	const withNull = successResponse("req_1", "cycle_model", null);
	assert.equal(withNull.success, true);
	assert.ok("data" in withNull, "data:null 必须保留字段（真实 CLI 可能回 {success:true,data:null}）");
	assert.equal(withNull.data, null);
	const omitted = successResponse("req_2", "abort", undefined);
	assert.equal("data" in omitted, false);
	const withObject = successResponse("req_3", "get_state", { sessionId: "s" });
	assert.deepEqual(withObject.data, { sessionId: "s" });
});
