/**
 * step-rpc-mock 输出原语（自 step-rpc-mock.mjs 机械拆分，代码体逐字保留）。
 *
 * takeOverStdout 语义：只有协议行走 fd1；诊断一律 stderr；stdout EPIPE 视作对端
 * 关闭，静默 exit 0（对齐 rpc-mode.ts 的进程语义）。
 *
 * 本文件派生自 stepfun-ai/Step-Code（https://github.com/stepfun-ai/Step-Code，
 * packages/coding-agent/src/modes/rpc-mode.ts 及 rpc/ 下的 jsonl/rpc-types/rpc-client），
 * 依其 MIT License 授权，原版权与许可声明随本文件保留：
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

import { serializeJsonLine } from "../src/jsonl.mjs";

process.stdout.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
	if (error.code === "EPIPE") {
		process.exit(0);
	}
	throw error;
});

/** @param {object} obj */
export const write = (obj) => {
	process.stdout.write(serializeJsonLine(obj));
};

/** @param {string} message */
export const diag = (message) => {
	process.stderr.write(`[step-rpc-mock] ${message}\n`);
};
