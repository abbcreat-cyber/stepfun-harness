/*
 * 会话管理命令（P1-01）：v4 renameSession 的改名四落点、deleteSession 的 intent
 * 双语义（draftCleanup 空草稿回收 / userDelete 用户显式删除——先归档后改索引）。
 * 从 bin/zcode-bridge-session.mjs 的 deleteSession 分支收口而来：draftCleanup 保持
 * 现行为原样+补写墓碑；userDelete 的删除顺序按评审重排为「先归档后改索引」——
 * trash 归档（正文+journal+附件全部 rename 进 STATE_DIR/trash，任何失败=整体抛错、
 * 索引未动、任务仍在列表可重试）→锁内索引过滤+墓碑（写失败 best-effort 回滚归档
 * 再抛错），附件不再物理删、全量可恢复。
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 * Community-maintained adapter; not affiliated with or endorsed by Z.ai.
 */
import { cpSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logging.mjs";
import { BridgeError } from "./errors.mjs";

/** 回滚单次已完成的搬迁（EXDEV 跨卷搬迁也做同步降级，失败仅 log——trash 副本仍在）。 */
function rollbackMove(move) {
	try {
		renameSync(move.to, move.from);
	} catch (error) {
		if (error.code === "EXDEV") {
			try {
				cpSync(move.to, move.from, { recursive: true });
				rmSync(move.to, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
				return;
			} catch {
				// 降级也失败：落在下面的通用兜底（log+保留 trash 副本）。
			}
		}
		log(`trash 归档回滚失败（保留 trash 副本以供手工恢复）: ${move.to} → ${move.from}: ${error?.message ?? error}`);
	}
}

/**
 * trash 归档：把会话的三项产物（conversations 正文 / workflows journal / attachments
 * 附件目录）全部 rename 进 STATE_DIR/trash/<enc(id)>-<ts>/，返回带 rollback() 的句柄。
 * 任何非 ENOENT 失败（含附件 EXDEV 降级复制的失败）=先把已 move 的部分回滚回原位再
 * 抛错——保持「索引未动、正文/附件全在原位、任务仍在列表可重试」的端到端零改动契约。
 * ENOENT（某项产物从未存在）一律容忍跳过（空态合法）。
 * 归档在锁外执行（后续锁内只做索引/墓碑写回），因此这里可以自由 await。
 * @param {{ STATE_DIR: string, conversationFile(id: string): string, attachmentStore: { directory(id: string): string, relocateSession(id: string, dir: string): Promise<string> } }} ctx
 * @param {string} sessionId
 * @returns {Promise<{ dir: string, rollback(): void }>}
 */
async function archiveSessionToTrash(ctx, sessionId) {
	const ts = Date.now();
	const trashDir = join(ctx.STATE_DIR, "trash", `${encodeURIComponent(sessionId)}-${ts}`);
	try {
		mkdirSync(trashDir, { recursive: true });
	} catch (error) {
		// trash 父路径不可写（被占用/路径中有文件等）：归档尚未开始，无需回滚——
		// 统一包成语义化错误码（-32000 + 中文上下文），保持「索引未动、全在原位、可重试」。
		throw new BridgeError(-32000, `归档会话数据失败: ${error?.message ?? error}`);
	}
	/** @type {Array<{ from: string, to: string }>} */ const moves = [];
	const rollback = () => {
		// 逆序搬回（后 move 的先回）。
		for (let i = moves.length - 1; i >= 0; i--) rollbackMove(moves[i]);
		// 归档目录本身清空后移除（Windows 句柄延迟释放时 maxRetries 兜底）。
		try { rmSync(trashDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
	};
	const moveTo = (from, to) => {
		try {
			renameSync(from, to);
		} catch (error) {
			if (error.code === "ENOENT") return false; // 该产物从未存在——空态容忍。
			throw error;
		}
		moves.push({ from, to });
		return true;
	};
	// ① conversations 正文 → conversation.json（含 rows 与 stepSessionFile 引用——原生
	//    step 会话文件不删不改，归档保留引用可审计/手工恢复）。
	try {
		moveTo(ctx.conversationFile(sessionId), join(trashDir, "conversation.json"));
	} catch (error) {
		rollback();
		throw new BridgeError(-32000, `归档会话正文失败: ${error?.message ?? error}`);
	}
	// ② 工作流 journal 目录（disposeSession 已在调用方先释放 sqlite 句柄——否则 Windows
	//    上目录 rename 会因句柄占用失败）。
	try {
		moveTo(join(ctx.STATE_DIR, "workflows", encodeURIComponent(sessionId)), join(trashDir, "workflows"));
	} catch (error) {
		rollback();
		throw new BridgeError(-32000, `归档会话工作流记录失败: ${error?.message ?? error}`);
	}
	// ③ 附件目录（AttachmentStore.relocateSession：跨卷 EXDEV 时 cp+rm 降级；源目录
	//    不存在的 ENOENT 由这里统一容忍——该会话从无附件）。
	const attachmentDir = ctx.attachmentStore.directory(sessionId);
	const attachmentTarget = join(trashDir, "attachments");
	try {
		await ctx.attachmentStore.relocateSession(sessionId, attachmentTarget);
		moves.push({ from: attachmentDir, to: attachmentTarget });
	} catch (error) {
		if (error.code !== "ENOENT") {
			rollback();
			throw new BridgeError(-32000, `归档会话附件失败: ${error?.message ?? error}`);
		}
	}
	return { dir: trashDir, rollback };
}

/**
 * @param {any} ctx 共享桥接状态（primarySession/conversationRows/ledger/attachmentStore
 *                  /workflowBridge/sessions-index 与 conversation-store 的全部落点等）
 */
export function createSessionAdmin(ctx) {
	/**
	 * v4 renameSession（P1-01 改名四落点）：
	 * ① title 非 string 或 trim 空 → -32000；
	 * ② 目标解析：primary 用内存、否则 readConversation 的 session，无记录 -32002；
	 * ③ primary 且 client 在时先 await client.setSessionName(title)——失败如实抛 -32000、
	 *    桥接侧零改动（此「先原生后落盘」顺序契约由 suites/v4-session-rename.mjs 的
	 *    mock-fail 注入用例钉住）；client 未启动或非 primary 会话跳过原生同步并 log——
	 *    非 primary 不调 restoreSession（避免 switch_session 切换底座会话+重放模型的副作用），
	 *    原生侧标题不同步是已知边界（桥接侧索引/正文已一致，见能力矩阵）；
	 * ④ 写 title+titleSource="custom"：primary 走 persistConversation（rows/statistics
	 *    同步落盘），非 primary 走 writeConversationSession（只换 session 元数据）；
	 * ⑤ renameSessionInIndex（全键换 title+bump lastActivityAt 水位，否则跨进程
	 *    pushPersistedUpserts 水位过滤会吞掉改名 delta）+ primary 时
	 *    broadcastSessionsIndexUpsert（live 投影立即生效）。
	 * 防覆盖守卫在 deriveSessionTitle 入口（custom 短路，同时覆盖两个派生点）与
	 * session/read 分支两处；task-index 侧由 services.renameTask 覆盖。
	 */
	async function renameSession({ sessionId, title }) {
		const trimmed = typeof title === "string" ? title.trim() : "";
		if (!trimmed) throw new BridgeError(-32000, "会话名称不能为空");
		const rename = async client => {
		// 等待客户端 owner 期间 primary 可能切换，锁内再确定原生与持久化落点。
		const isPrimary = ctx.primarySession?.sessionId === sessionId;
		const session = isPrimary ? ctx.primarySession : ctx.readConversation(sessionId)?.session;
		if (!session) throw new BridgeError(-32002, "找不到该会话的本地记录");
		if (isPrimary && client) {
			try {
				await client.setSessionName(trimmed);
			} catch (error) {
				// 显式改名命令失败必须如实报错（不吞错、不继续落盘——否则桥接与原生两侧
				// 标题分叉且原生侧永远无法补同步）。
				throw new BridgeError(-32000, `同步 Step 底座会话名失败: ${error?.message ?? error}`);
			}
		} else {
			log(
				`renameSession 跳过原生 set_session_name（${isPrimary ? "底座 client 未启动" : "非 primary 会话，不切换底座会话"}）sessionId=${sessionId}`,
			);
		}
		session.title = trimmed;
		session.titleSource = "custom";
		if (isPrimary) ctx.persistConversation();
		else ctx.writeConversationSession(sessionId, session);
		ctx.renameSessionInIndex(sessionId, trimmed);
		if (isPrimary) ctx.broadcastSessionsIndexUpsert();
		log(`renameSession sessionId=${sessionId} titleLength=${trimmed.length} primary=${isPrimary ? 1 : 0}`);
		};
		// setName 与落盘必须在同一事务；refresh 不得捕获旧名后覆盖刚完成的改名。
		if (ctx.primarySession?.sessionId === sessionId) return ctx.runClientOperation(async () => {
			// rebuild 的 null 窗口也在同一锁内；未启动时仍保留只改本地记录的语义。
			await ctx.clientStartPromise;
			return rename(ctx.client);
		});
		return rename(null);
	}

	/** draftCleanup 语义（现行空草稿守卫原样）：仅未发送消息的空白草稿可回收。 */
	async function deleteSessionDraftCleanup(sessionId) {
		const saved = ctx.primarySession?.sessionId === sessionId
			? { session: ctx.primarySession, rows: ctx.conversationRows }
			: ctx.readConversation(sessionId);
		if (saved?.rows?.length || (ctx.turnBusy && ctx.primarySession?.sessionId === sessionId)) {
			throw new BridgeError(-32000, "只能自动清理未发送消息的空白草稿");
		}
		if (ctx.primarySession?.sessionId === sessionId) {
			if (ctx.client) await ctx.client.stop();
			ctx.client = null; ctx.clientStartPromise = null; ctx.primarySession = null; ctx.conversationRows = []; ctx.streamProjection = null;
			ctx.ledger.reset();
		}
		// 索引过滤+墓碑+正文 unlink 统一走一份代码（session-lifecycle 的 cleanupEmptyDraft
		// 薄委托同一原语——双份清理收口）。
		ctx.removeSessionInIndex(sessionId, { registerTombstone: true });
		await unlink(ctx.conversationFile(sessionId)).catch((error) => { if (error.code !== "ENOENT") throw error; });
	}

	/**
	 * userDelete 语义（用户显式确认后的破坏性全量删除，评审修订：先归档后改索引）：
	 * ① 目标解析（primary 内存 rows，否则 readConversation；无记录 -32002）；
	 * ② primary 且 turnBusy → -32000（会话运行中，请先停止后再删除）；
	 * ③ 审计 log 行；④ disposeSession 释放工作流 journal sqlite 句柄（必须先于 workflows
	 *    目录 rename——Windows 上句柄未释放时目录改名会失败；失败抛错=零改动可重试）；
	 * ⑤ trash 归档（全部可逆 rename，任一失败=整体抛错、索引未动、任务仍在列表可重试）；
	 * ⑥ 锁内：索引全键过滤+墓碑+写回——锁内写失败→best-effort 把 trash 三项 rename 回
	 *    原位（回滚失败仅 log、trash 副本保留）→抛错如实上报；
	 * ⑦ 若是 primary：client.stop（try/catch，停进程失败不阻断删除——索引与文件已清理，
	 *    底座进程无会话可续，下次 ensureClient 自会重建）+清内存态；⑧ ack（无 result）。
	 */
	async function deleteSessionForUser(sessionId) {
		const isPrimary = ctx.primarySession?.sessionId === sessionId;
		const saved = isPrimary
			? { session: ctx.primarySession, rows: ctx.conversationRows }
			: ctx.readConversation(sessionId);
		if (!saved?.session) throw new BridgeError(-32002, "找不到该会话的本地记录");
		if (isPrimary && ctx.turnBusy) throw new BridgeError(-32000, "会话运行中，请先停止后再删除");
		log(`deleteSession intent=userDelete sessionId=${sessionId} rows=${saved.rows?.length ?? 0} title=${saved.session.title ?? ""} primary=${isPrimary ? 1 : 0}`);
		// ④ 释放工作流资源（无则跳过；失败=删除整体失败，索引/正文未动可重试）。
		await ctx.workflowBridge.disposeSession(sessionId);
		// ⑤ trash 归档。
		const archive = await archiveSessionToTrash(ctx, sessionId);
		// ⑥ 锁内改索引+墓碑；失败回滚归档再抛错。
		try {
			ctx.removeSessionInIndex(sessionId, { registerTombstone: true });
		} catch (error) {
			log(`deleteSession 索引/墓碑写入失败，回滚归档: ${error?.message ?? error}`);
			archive.rollback();
			throw error;
		}
		// ⑦ primary 清内存态（索引与文件均已清理，此处失败也不再影响删除结果）。
		if (isPrimary) {
			if (ctx.client) {
				try { await ctx.client.stop(); }
				catch (error) { log(`deleteSession 停止底座进程失败（忽略，下次 ensureClient 重建）: ${error?.message ?? error}`); }
			}
			ctx.client = null; ctx.clientStartPromise = null; ctx.primarySession = null; ctx.conversationRows = []; ctx.streamProjection = null;
			ctx.ledger.reset();
		}
	}

	/**
	 * v4 deleteSession 统一入口：payload.intent 分流（shared 协议层枚举
	 * draftCleanup|userDelete，optional）。缺省（含 payload:{} 的既有调用方
	 * useDraftSessionPrewarm / useSavedWorkflowLauncher）=draftCleanup——空草稿守卫
	 * 不变；userDelete=先归档后改索引的全量删除。桥接侧对 intent 宽松处理（对齐
	 * envelope 既有宽松惯例），未知值按缺省语义兜底。
	 */
	async function deleteSession({ sessionId, intent }) {
		if (intent === "userDelete") return deleteSessionForUser(sessionId);
		return deleteSessionDraftCleanup(sessionId);
	}

	// 经命名空间对象挂到 ctx（bin 装配 Object.assign(ctx, createSessionAdmin(ctx)) 后
	// 以 ctx.sessionAdmin.* 消费）——与其它拆分模块的平铺返回不同：rename/delete 与
	// v4/command envelope 的 type 字段同名，平铺会与命令分发面的语义字段混淆。
	return { sessionAdmin: { renameSession, deleteSession, deleteSessionDraftCleanup, deleteSessionForUser } };
}
