/*
 * 会话正文/统计的逐会话持久化（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）：
 * conversations/<sessionId>.json 的原子写读、SessionStatistics 账本的水化、
 * 附件行的读取辅助。Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import { readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { SessionStatistics } from "../session-statistics.mjs";
import { readSessionTimingHistory } from "../session-timing-history.mjs";
import { log } from "./logging.mjs";
import { BridgeError } from "./errors.mjs";

/** @param {any} ctx 共享桥接状态（primarySession/conversationRows/STATE_DIR 等） */
export function createConversationStore(ctx) {
	function attachmentRows(id) { return ctx.primarySession?.sessionId===id?ctx.conversationRows:(readConversation(id)?.rows??[]); }
	function assertAttachmentSession(p) {
		// session worker（session-router.mjs 注入 STEPCODE_SESSION_WORKER=1）放行预分配
		// sessionId 的附件上传：AttachmentStore 按 sessionId 目录寻址（attachments.mjs 的
		// directory(sessionId)），不依赖会话已存在；桌面 UI 现路径有附件时先建空会话再
		// sendText（SessionPane.tsx:2820-2839），此放宽零影响。
		if (ctx.IS_SESSION_WORKER) return;
		if(ctx.primarySession?.sessionId!==p.sessionId&&!readConversation(p.sessionId)?.session)throw new Error("找不到附件所属会话");
	}

	// 每个会话单独落盘，避免不同桥接实例覆盖彼此的历史内容。
	function conversationFile(sessionId) {
		return join(ctx.STATE_DIR, "conversations", `${encodeURIComponent(sessionId)}.json`);
	}
	function readConversation(sessionId) {
		try { return JSON.parse(readFileSync(conversationFile(sessionId), "utf8")); }
		catch { return null; }
	}
	const statisticsBySession = new Map();
	const statisticsLoads = new Map();
	function sessionStatistics(sessionId) {
	 if (!statisticsBySession.has(sessionId)) statisticsBySession.set(sessionId,new SessionStatistics(readConversation(sessionId)?.statistics));
	 return statisticsBySession.get(sessionId);
	}
	async function hydrateStatistics(sessionId) {
	 if (!statisticsLoads.has(sessionId)) {
	  const load = (async () => {
	   const saved=readConversation(sessionId);
	   const stats=sessionStatistics(sessionId);
	   // 启动后与原生账本补账：崩溃前已落账但未写快照的响应不能丢失。
	   const session=ctx.primarySession?.sessionId===sessionId ? ctx.primarySession : saved?.session;
	   if (!session?.stepSessionFile) return;
	   try {
	    const lines=(await readFile(session.stepSessionFile,"utf8")).split("\n"),entries=[];
	    for (let i=0;i<lines.length;i++) {if (!lines[i].trim()) continue;try {entries.push(JSON.parse(lines[i]));} catch(error) {if(i<lines.length-1) throw error;}}
	    stats.seed(entries);
	    stats.recoverTimings(entries, await readSessionTimingHistory(entries,[process.env.STEPCODE_STORAGE_ROOT_DIR ? join(process.env.STEPCODE_STORAGE_ROOT_DIR,"telemetry") : null, join(homedir(),".stepcode","telemetry")]));
	    return stats.totals.steps > 0 || stats.totals.turns > 0;
	   } catch(error) {if(error.code!=="ENOENT") log("session statistics unavailable: "+error.message);}
	  })();
	  statisticsLoads.set(sessionId,load);
	 }
	 return await statisticsLoads.get(sessionId);
	}
	function persistConversation() {
		if (!ctx.primarySession) return;
		const file = conversationFile(ctx.primarySession.sessionId);
		mkdirSync(dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify({ session: ctx.primarySession, rows: ctx.conversationRows, queueEntries: ctx.ledger.serializeQueue(), statistics: sessionStatistics(ctx.primarySession.sessionId).serialize() }), "utf8");
		renameSync(temp, file);
	}

	/**
	 * 只替换非 primary 会话正文里的 session 元数据（rows/statistics 原样保留），供
	 * session-admin 的 renameSession 等「后台会话元数据变更」落盘——模式与
	 * persistConversation 一致（tmp+rename 原子替换）。目标会话无本地记录时抛
	 * BridgeError(-32002)（调用方在此之前通常已解析过一次 session，这里是同一竞态
	 * 窗口内的防御性兜底，语义与 restoreSession 的 -32002 文案一致）。
	 * @param {string} sessionId
	 * @param {any} session
	 */
	function writeConversationSession(sessionId, session) {
		const saved = readConversation(sessionId);
		if (!saved) throw new BridgeError(-32002, "找不到该会话的本地记录");
		const file = conversationFile(sessionId);
		mkdirSync(dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify({ ...saved, session }), "utf8");
		renameSync(temp, file);
	}

	return { attachmentRows, assertAttachmentSession, conversationFile, readConversation, sessionStatistics, hydrateStatistics, persistConversation, writeConversationSession };
}
