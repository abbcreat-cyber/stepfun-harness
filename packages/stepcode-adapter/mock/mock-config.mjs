/**
 * step-rpc-mock 运行配置（自 step-rpc-mock.mjs 机械拆分）。
 *
 * 原实现是单文件内的模块级 `let delayMs/hangCommand`；拆分后由主入口在解析
 * argv 后写回本对象，各模块读取当前值——读取时机与原 live 绑定语义一致。
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

export const mockConfig = {
	/** 事件间延迟（默认 2；0 = 全速）。先取 STEP_MOCK_DELAY_MS，主入口可用 --delay 覆盖。 */
	delayMs: Number(process.env.STEP_MOCK_DELAY_MS ?? 2),
	/**
	 * 收到该类型命令后不回响应（--hang，测客户端超时/进程退出时的 pending reject）。
	 * @type {string | null}
	 */
	hangCommand: null,
	/**
	 * 晚绑定的 CLI models.json 文件路径（STEP_MOCK_MODELS_FILE，协议级测试注入面）。
	 * null（未设该 env）= 默认关闭门：mock 的 set_model/get_available_models 行为与
	 * 现状逐字节一致；已设 = resolveMockModels() 每次调用惰性读文件合并自定义供应商条目
	 * （形状镜像真实 CLI 的 ~/.stepcode/models.json：{providers:{id:{api,baseUrl,apiKey,models[]}}}）。
	 * 读取时机=每次 set_model/get_available_models 调用（晚绑定），使「会话中途写入条目后
	 * 下一次调用生效」的宿主同步时序在协议级可观测。任何路径都不输出 apiKey。
	 * @type {string | null}
	 */
	modelsFile: process.env.STEP_MOCK_MODELS_FILE ?? null,
};
