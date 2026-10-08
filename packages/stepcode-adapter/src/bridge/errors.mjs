/*
 * bridge 协议错误类型（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）：
 * 携带 JSON-RPC 错误码的桥接异常，handleRequestLine 按 code 回给 host。
 * 全部拆分模块共用同一个类定义（instanceof 跨模块判定必须命中同一对象）。
 */
export class BridgeError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}
