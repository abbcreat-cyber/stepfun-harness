/**
 * 严格 JSONL（LF-only）编解码。
 *
 * 忠实复刻 Step-Code/packages/coding-agent/src/modes/rpc/jsonl.ts：
 * - 帧边界只认 `\n`（U+2028/U+2029 是合法 JSON 字符串内容，不得作为帧界）；
 * - 读取容忍行尾 `\r`；
 * - 不用 node:readline（readline 会按额外 Unicode 分隔符分行，不符合严格 JSONL）；
 * - 流结束时冲刷无尾换行的最后一段。
 *
 * 本文件移植自 stepfun-ai/Step-Code（https://github.com/stepfun-ai/Step-Code，
 * packages/coding-agent/src/modes/rpc/jsonl.ts），依其 MIT License 授权，
 * 原版权与许可声明随本文件保留：
 *
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2026 Step Code
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

import { StringDecoder } from "node:string_decoder";

/**
 * 序列化一条严格 JSONL 记录（JSON + LF）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function serializeJsonLine(value) {
	return `${JSON.stringify(value)}\n`;
}

/**
 * 给流挂一个 LF-only 的逐行读取器。
 *
 * @param {import("node:stream").Readable} stream
 * @param {(line: string) => void} onLine 每收到一行调用一次（已剥掉行尾 \r）
 * @returns {() => void} 卸载函数
 */
export function attachJsonlLineReader(stream, onLine) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	/** @param {string} line */
	const emitLine = (line) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	/** @param {string | Buffer} chunk */
	const onData = (chunk) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
