/*
 * 方法处理器·v4 订阅与工作流面（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）：
 * v4/conversation/subscribe|unsubscribe|resync、v4/connection/flow 背压、
 * v4/attachment/*、workflows/* 与 v4/conversation/workflowRun* 族、
 * v4/conversation/plans、bridge/refreshSessionIndex。
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import { makeSubscribeAck, nextId } from "../wire-shapes.mjs";
import { log } from "./logging.mjs";
import { BridgeError } from "./errors.mjs";

/** @param {any} ctx 共享桥接状态（v4Subscriptions/ownedSubscriptions/connectionFlowStates 等） */
export function createV4Methods(ctx) {
	return {
		"workflows/runs": p => ctx.workflowBridge.savedRuns(p),
	 "workflows/list": async p => (await ctx.savedCatalog(p)).list(p),
	 "workflows/get": async p => (await ctx.savedCatalog(p)).get(p),
	 "workflows/updateMeta": async p => (await ctx.savedCatalog(p)).update(p),
	 "workflows/delete": async p => (await ctx.savedCatalog(p)).delete(p),
	 "v4/conversation/workflowRuns": async p => ({ runs: await ctx.workflowBridge.listRuns(p.sessionId) }),
	 "v4/conversation/workflowRunArtifacts": async p => (await ctx.workflowBridge.service(p.sessionId)).artifacts(p.runId),
	 "v4/conversation/workflowRunArtifactData": async p => (await ctx.workflowBridge.service(p.sessionId)).artifactData(p),
	 "v4/conversation/workflowRunArtifactRead": async p => (await ctx.workflowBridge.service(p.sessionId)).artifactRead(p),
	 "v4/conversation/workflowRunWorkspace": async p => (await ctx.workflowBridge.service(p.sessionId)).workspace(p.runId),
	 "v4/conversation/workflowRunNodeResult": async p => (await ctx.workflowBridge.service(p.sessionId)).nodeResult(p),
	 "v4/conversation/workflowRunEvents": async p => (await ctx.workflowBridge.service(p.sessionId)).events(p.runId, p.afterSequence, p.limit),
		"v4/conversation/plans": () => ({ plans: [], atSeq: ctx.conversationSeq, atLogEpoch: ctx.logEpoch }),
		"bridge/refreshSessionIndex": () => { ctx.pushPersistedUpserts();return {}; },
	    "v4/attachment/begin": p => {ctx.assertAttachmentSession(p);return ctx.attachmentStore.begin(p);},
	 "v4/attachment/chunk": p => {ctx.assertAttachmentSession(p);return ctx.attachmentStore.chunk(p);},
	 "v4/attachment/commit": p => {ctx.assertAttachmentSession(p);return ctx.attachmentStore.commit(p);},
	 "v4/attachment/abort": p => ctx.attachmentStore.abort(p),
	 "v4/attachment/read": p => ctx.attachmentStore.read(p,ctx.attachmentRows(p.sessionId)),
	 "v4/conversation/attachmentRead": p => ctx.attachmentStore.read(p,ctx.attachmentRows(p.sessionId)),
	 "v4/attachment/previewSource": () => ({kind:"chunked"}),

		/**
		 * 连接背压（v4ConnectionFlowResultSchema 唯一合法结果就是 {}）：记录 per-
		 * connection 状态并真正执行——saturated/closed 的连接暂停在线帧投递（notify），
		 * drained 恢复。参数非法时如实 -32602，不吞成成功。
		 */
		"v4/connection/flow": (params) => {
			const connectionId = typeof params?.connectionId === "string" ? params.connectionId : "";
			const state = params?.state;
			if (!connectionId || (state !== "saturated" && state !== "drained" && state !== "closed")) {
				throw new BridgeError(-32602, "v4/connection/flow 需要 connectionId 与 state（saturated|drained|closed）");
			}
			const previous = ctx.connectionFlowStates.get(connectionId);
			ctx.connectionFlowStates.set(connectionId, state);
			if (previous !== state) log(`connection flow ${connectionId}: ${previous ?? "drained"} → ${state}`);
			return {};
		},

		"v4/conversation/subscribe": (params) => {
			const topic = String(params?.topic ?? "");
			const subscriptionId = nextId("sub");
			ctx.v4Subscriptions.set(topic, subscriptionId);
			for (const [id, owner] of ctx.ownedSubscriptions) {
				if (owner.topic === topic && owner.connectionId === params.connectionId) ctx.ownedSubscriptions.delete(id);
			}
			ctx.ownedSubscriptions.set(subscriptionId, { topic, connectionId: params.connectionId });
			const result = { ack: makeSubscribeAck({ subscriptionId, logEpoch: ctx.logEpoch }) };
			// 初始帧在响应行之后发出（与 CLI server 的 post-response outbox 时序一致）。
			setImmediate(() => {
				if (topic.startsWith("conversation/")) {
					ctx.broadcastConversationSnapshot(topic, "initial", subscriptionId);
	                void ctx.hydrateStatistics(topic.slice(13)).then(changed => { if (changed) ctx.broadcastConversationSnapshot(topic); }).catch(error=>log(error.message));
	                if (ctx.readConversation(topic.slice(13))) void ctx.workflowBridge.hydrate(topic.slice(13)).then(() => ctx.broadcastConversationSnapshot(topic)).catch(error => log(error.message));
				} else if (topic.startsWith("sessions-index/")) {
					ctx.broadcastSessionsIndexSnapshot(topic, "initial", subscriptionId);
				} else if (topic.startsWith("workspace-config/")) {
					ctx.broadcastWorkspaceConfig(topic, subscriptionId, "initial");
				}
			});
			return result;
		},

		"v4/conversation/unsubscribe": (params) => {
			const owner = ctx.ownedSubscriptions.get(params.subscriptionId);
			if (owner && (!params.connectionId || owner.connectionId === params.connectionId)) {
				ctx.ownedSubscriptions.delete(params.subscriptionId);
				ctx.deliveredConversationSeqs.delete(params.subscriptionId);
				const remaining = [...ctx.ownedSubscriptions].find(([, item]) => item.topic === owner.topic);
				if (remaining) ctx.v4Subscriptions.set(owner.topic, remaining[0]);
				else ctx.v4Subscriptions.delete(owner.topic);
				// 该连接已无任何订阅时回收流控状态（防 connectionId 级泄漏）。
				if (![...ctx.ownedSubscriptions.values()].some((item) => item.connectionId === owner.connectionId)) {
					ctx.connectionFlowStates.delete(owner.connectionId);
				}
			}
			return {};
		},

		"v4/conversation/resync": (params) => {
			const topic = String(params?.topic ?? "");
			const subscriptionId = params.subscriptionId ?? ctx.v4Subscriptions.get(topic);
			const owner = ctx.ownedSubscriptions.get(subscriptionId);
			if (!owner || owner.topic !== topic || (params.connectionId && owner.connectionId !== params.connectionId)) {
				throw new BridgeError(-32000, "subscription.notOwned");
			}
			if (topic.startsWith("conversation/")) {
				// 必须按 resync 的 topic 回帧（不能默认当前 primary 会话）：冷订阅/历史 topic
				// 的恢复握手在 ack 后限时等不到该 topic 的帧即 fail-closed。
				setImmediate(() => ctx.broadcastConversationSnapshot(topic, "recovery", subscriptionId));
			} else if (topic.startsWith("sessions-index/")) {
				// gap 触发的 forceSnapshot 重订：对 sessions-index 重发完整 snapshot（含
				// primarySession），覆盖此前只处理 conversation/ 的缺口。
				setImmediate(() => ctx.broadcastSessionsIndexSnapshot(topic, "recovery", subscriptionId));
			} else if (topic.startsWith("workspace-config/")) {
				setImmediate(() => ctx.broadcastWorkspaceConfig(topic, subscriptionId, "recovery"));
			}
			return { ack: makeSubscribeAck({ subscriptionId, logEpoch: ctx.logEpoch }) };
		},
	};
}
