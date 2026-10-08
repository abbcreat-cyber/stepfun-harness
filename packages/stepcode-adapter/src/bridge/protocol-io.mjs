/*
 * bridge 协议写出（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）：
 * stdout NDJSON 帧 + v4 在线广播的连接背压/多订阅扇出。
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import process from "node:process";
import { serializeJsonLine } from "../jsonl.mjs";

/**
 * @param {{ ownedSubscriptions: Map<string, any>, connectionFlowStates: Map<string, string>,
 *           deliveredConversationSeqs: Map<string, number> }} ctx 共享桥接状态
 */
export function createProtocolIo(ctx) {
	// ── 协议写出 ────────────────────────────────────────────────────────────────
	function writeFrame(frame) {
		process.stdout.write(serializeJsonLine(frame));
	}

	function respondResult(id, result) {
		writeFrame({ id, result });
	}

	function respondError(id, code, message) {
		writeFrame({ id, error: { code, message } });
	}

	function notify(method, params) {
		// 同一 topic 可被多个窗口订阅；在线广播必须覆盖每个订阅，不能互相抢占。
		if (method === "v4/conversation/frame" && params.deliveryKind === "online") {
			for (const [id, owner] of ctx.ownedSubscriptions) {
				if (owner.topic !== params.topic) continue;
				// 连接背压（v4/connection/flow）：saturated/closed 的连接暂停在线帧投递，
				// host 侧 seq gap 检测会触发 resync 重订补齐；initial/recovery 帧是订阅/
				// 重订的定向应答，不在此列。
				const flow = ctx.connectionFlowStates.get(owner.connectionId);
				if (flow === "saturated" || flow === "closed") continue;
				const frame = { ...params.frame, subscriptionId: id };
				if (params.topic.startsWith("conversation/")) {
					if (frame.payload.kind === "deltas" && !ctx.deliveredConversationSeqs.has(id)) continue;
					if (frame.payload.kind === "deltas") frame.fromSeq = ctx.deliveredConversationSeqs.get(id);
					ctx.deliveredConversationSeqs.set(id, frame.toSeq);
				}
				writeFrame({ method, params: { ...params, subscriptionId: id, frame } });
			}
			return;
		}
		if (method === "v4/conversation/frame" && params.topic.startsWith("conversation/")) {
			ctx.deliveredConversationSeqs.set(params.subscriptionId, params.frame.toSeq);
		}
		writeFrame({ method, params });
	}

	return { writeFrame, respondResult, respondError, notify };
}
