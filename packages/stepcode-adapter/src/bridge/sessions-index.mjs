/*
 * sessions-index 持久化与投影（自 bin/zcode-bridge-session.mjs 纯机械拆出，行为不变）：
 * 跨桥接进程共享的会话摘要落盘（tmp+rename 原子替换）、冷订阅快照、跨进程
 * upsert 推送与共享状态文件轮询。Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import { mkdirSync, readFileSync, renameSync, watchFile, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import process from "node:process";
import { withSessionIndexLock } from "../session-index-lock.mjs";
import {
	makeConversationDeltasFrame,
	makeConversationSnapshotFrame,
	makeSessionSummary,
	makeSessionsIndexSnapshot,
} from "../wire-shapes.mjs";
import { log } from "./logging.mjs";

/** @param {any} ctx 共享桥接状态（STATE_DIR/notify/v4Subscriptions/primarySession 等） */
export function createSessionsIndex(ctx) {
	// ── sessions-index 持久化（跨桥接进程 + 跨重启共享会话摘要）─────────────────
	// host 会为不同连接（task-index / window-controller / host-rpc）各起一个桥接进程：
	// 处理建会话命令的桥接与持有 sessions-index 订阅的桥接往往不是同一个进程，进程内
	// 广播到不了对方；桥接重启后内存清零也会让快照退化为空。这里把会话摘要落盘共享：
	// 命令侧在建会话/turn 终态时写入，索引侧在订阅/重订快照时读取合并——host 约 30s
	// 一次的 sessions-index resync 就是自然的拉取节拍。写入走 tmp+rename 原子替换；
	// 并发写在最后一写者胜（各自的下次落盘自愈），读失败按空处理。
	function normalizeWorkspaceKey(workspacePath, identity = false) {
		const key = String(workspacePath);
		// 路径延续 Windows 归一化；逻辑 identity 是不透明值，不能折叠大小写。
		return identity || !isAbsolute(key) ? key : key.replaceAll("/", "\\").toLowerCase();
	}

	function readPersistedWorkspaces() {
		try {
			const parsed = JSON.parse(readFileSync(ctx.STATE_FILE, "utf8"));
			if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.workspaces
				&& typeof parsed.workspaces === "object") {
				return parsed.workspaces;
			}
		} catch {
			// 首次运行/损坏/并发替换窗口：一律按空态处理。
		}
		return {};
	}

	function persistSessionSummary(workspacePath, summary, identity = false) {
		try {
			// 墓碑防复活（写前过滤）：已删除的会话即便因跨进程竞态短暂成为某桥接进程的
			// primary（其内存 live upsert 可能短暂复活条目），也不得再写进持久化索引。
			if (tombstoned(summary.sessionId)) {
				log(`sessions-index persist 跳过已删除会话（墓碑防复活）: ${summary.sessionId}`);
				return;
			}
			const key = normalizeWorkspaceKey(workspacePath, identity);
			return withSessionIndexLock(ctx.STATE_DIR, () => {
				const workspaces = readPersistedWorkspaces();
				const list = Array.isArray(workspaces[key]) ? [...workspaces[key]] : [];
				const index = list.findIndex((s) => s?.sessionId === summary.sessionId);
				if (index >= 0) list[index] = summary;
				else list.push(summary);
				while (list.length > 200) list.shift();
				workspaces[key] = list;
				mkdirSync(ctx.STATE_DIR, { recursive: true });
				const tmp = `${ctx.STATE_FILE}.${process.pid}.tmp`;
				writeFileSync(tmp, JSON.stringify({ version: 1, workspaces }), "utf8");
				renameSync(tmp, ctx.STATE_FILE);
				if(ctx.IS_SESSION_WORKER)setImmediate(()=>ctx.notify("bridge/sessionIndexChanged",{}));
			});
		} catch (error) {
			log(`sessions-index persist 失败: ${error?.message ?? error}`);
		}
	}

	function persistedSummariesFor(workspacePath, identity = Boolean(ctx.primarySession?.workspace?.workspaceIdentity) || !isAbsolute(String(workspacePath)), { afterWatermarks, sessionIds, projectSummary } = {}) {
		const workspaces = readPersistedWorkspaces();
		const key = normalizeWorkspaceKey(workspacePath, identity);
		const legacyKey = String(workspacePath).replaceAll("/", "\\").toLowerCase();
		const list = [...(Array.isArray(workspaces[key]) ? workspaces[key] : [])];
		// 旧版本把 identity 按路径存入 lower bucket，只接回精确身份，不能混入大小写不同的租户。
		if (identity && legacyKey !== key && Array.isArray(workspaces[legacyKey])) list.push(...workspaces[legacyKey].filter(item => item.workspaceId === workspacePath));
		const scoped = identity ? list.filter(item => item.workspaceId === workspacePath) : list;
		// 墓碑防复活（读后过滤）：即便索引文件里仍残留被删会话条目（另一进程的旧写回、
		// 或删除进程在写回索引前崩溃留下的半状态），读侧也不得把它再投影出去。
		const tombstones = tombstoneSet();
		const unique = new Map();
		// exact bucket 在前；legacy 只能补缺项，不能覆盖新的标题/活动水位。
		for (const summary of scoped) if (summary && typeof summary.sessionId === "string" && !tombstones.has(summary.sessionId) && !unique.has(summary.sessionId)) unique.set(summary.sessionId, summary);
		// 增量推送原本读完全部聊天正文才按水位丢弃旧摘要，历史越长重复 IO 越多。
		// 先按同一水位过滤；完整快照不传水位，仍逐条校正空草稿，不引入正文缓存。
		return [...unique.values()].filter(s => {
			if (sessionIds && !sessionIds.has(s.sessionId)) return false;
			const watermark = afterWatermarks?.get(s.sessionId);
			return watermark === undefined || watermark < (Number(s.lastActivityAt) || 0);
		}).map(s => {
			const saved = ctx.readConversation(s.sessionId);
			const summary = saved?.rows?.length === 0 ? { ...s, phase: "draft" } : s;
			// session/list 复用本次读取的元数据，避免为 mode/model 再解析整份历史；不驻留正文。
			return projectSummary ? projectSummary(summary, saved?.session) : summary;
		});
	}

	/** 把 primarySession 的当前摘要落盘（建会话与 turn 终态时各一次）。 */
	function persistPrimarySummary() {
		if (!ctx.primarySession) return;
		ctx.primarySession.title = deriveSessionTitle();
		ctx.persistConversation();
		const workspace = ctx.primarySession.workspace;
		const workspaceId = workspace?.workspaceKey ?? workspace?.workspaceIdentity ?? workspace?.workspacePath ?? process.cwd();
		const summary = makePrimarySessionSummary(workspaceId);
		if (summary) persistSessionSummary(workspaceId, summary, Boolean(workspace?.workspaceIdentity));
	}

	/** 从已积累的 conversation 行派生列表标题：首条用户消息截前 30 字符（码点口径），缺省用创建时间兜底。 */
	function deriveSessionTitle() {
		if (!ctx.primarySession) return undefined;
		// custom 短路（P1-01 防覆盖守卫）：用户显式重命名过的标题不再被自动派生覆盖——
		// 此处一处入口同时覆盖 persistPrimarySummary(:73) 与 makePrimarySessionSummary(:99)
		// 两个派生点；restoreSession 恢复的 session 对象自带 titleSource，自动生效。
		if (ctx.primarySession.titleSource === "custom") return ctx.primarySession.title;
		const firstUserText = ctx.conversationRows.find((row) => row.kind === "userInput")?.text?.trim();
		if (firstUserText) {
			const chars = Array.from(firstUserText);
			return chars.length > 30 ? `${chars.slice(0, 30).join("")}…` : firstUserText;
		}
		const created = new Date(ctx.primarySession.createdAt ?? Date.now());
		const pad = (n) => String(n).padStart(2, "0");
		return `${created.getMonth() + 1}月${created.getDate()}日 ${pad(created.getHours())}:${pad(created.getMinutes())} 的对话`;
	}

	/** primarySession → 单条 SessionSummary（snapshot 与 delta 共用）。 */
	function makePrimarySessionSummary(workspaceId) {
		if (!ctx.primarySession) return null;
		const workspace = ctx.primarySession.workspace;
		const identity = Boolean(workspace?.workspaceIdentity);
		if (normalizeWorkspaceKey(workspace?.workspaceKey ?? workspace?.workspaceIdentity ?? workspace?.workspacePath, identity) !== normalizeWorkspaceKey(workspaceId, identity)) return null;
		// Mini/侧栏只订阅索引；conversation 有确认框但索引漏计数时会错误显示运行中。
		const activity = ctx.workflowBridge?.snapshot(ctx.primarySession.sessionId);
		const pending = activity?.pendingInteractions ?? [];
		return makeSessionSummary({
			sessionId: ctx.primarySession.sessionId,
			workspaceId,
			title: deriveSessionTitle(),
			phase: ctx.turnBusy ? "running" : ctx.conversationRows.length ? "completedSuccess" : "draft",
			sessionEnded: false,
			hasBackgroundWork: (activity?.backgroundWorks?.length ?? 0) > 0,
			pendingInteractionSummary: {
				permissionCount: pending.filter(item => item.kind === "permission").length,
				userInputCount: pending.filter(item => item.kind === "userInput").length,
			},
			lastActivityAt: Date.now(),
			createdAt: ctx.primarySession.createdAt ?? Date.now(),
		});
	}

	// ── sessions-index 投影：让 host 侧 syncer 把社区会话写进 tasks-index ─────────
	// 根因（社区模式侧栏「暂无任务」）：UI 首条消息走 v4 createSession、不经 createTask，
	// sqlite 行只能由 zcodeTaskIndexSyncer 消费 sessions-index 帧写入；而桥此前只在订阅
	// 那一刻发一次 snapshot（当时 primarySession 尚不存在→空基线），之后从不发
	// session.upserted delta。这里补齐：会话创建后、turn 结束后各 upsert 一次，
	// resync 时对 sessions-index/ 重发完整 snapshot。

	/**
	 * 推进全局 seq 到「严格大于该 topic 已发水位」并返回新 toSeq。
	 * session/create 会把 conversationSeq 重置为 0（新会话新 topic 的既有语义），
	 * 而 sessions-index topic 跨会话延续、syncer 只接受 toSeq 严格递增的帧——
	 * 直接用重置后的 conversationSeq 会发出 toSeq <= 已应用 indexSeq 的帧被静默丢弃。
	 */
	function nextSessionsIndexSeq(topic) {
		const lastSeq = sessionsIndexTopicSeqs.get(topic) ?? 0;
		const toSeq = Math.max(ctx.conversationSeq, lastSeq) + 1;
		ctx.conversationSeq = toSeq;
		return { lastSeq, toSeq };
	}

	/** 向指定 sessions-index topic 重发完整 snapshot（订阅初始帧与 resync 共用）。 */
	function broadcastSessionsIndexSnapshot(topic, deliveryKind, targetSubscriptionId) {
		const subscriptionId = targetSubscriptionId ?? ctx.v4Subscriptions.get(topic);
		if (!subscriptionId) return;
		const workspaceId = topic.slice("sessions-index/".length);
		const { toSeq } = nextSessionsIndexSeq(topic);
		// 本进程 primary + 持久化历史合并：订阅/重订方（可能是另一个桥接进程的宿主连接，
		// 也可能是重启后的第一次快照）必须能看到全部会话，而不是只看到本进程内存里的。
		const sessions = [];
		const primarySummary = ctx.primarySession ? makePrimarySessionSummary(workspaceId) : null;
		if (primarySummary) sessions.push(primarySummary);
		for (const persisted of persistedSummariesFor(workspaceId)) {
			if (primarySummary && persisted.sessionId === primarySummary.sessionId) continue;
			sessions.push(persisted);
		}
		ctx.notify(
			"v4/conversation/frame",
			makeConversationSnapshotFrame({
				deliveryKind,
				topic,
				subscriptionId,
				toSeq,
				snapshot: makeSessionsIndexSnapshot({
					workspaceId,
					logEpoch: ctx.logEpoch,
					sessions,
				}),
			}),
		);
		sessionsIndexTopicSeqs.set(topic, toSeq);
		markSummariesSeen(topic, sessions);
	}

	// ── 跨进程实时传播：监听共享状态文件，把新会话/变更推给本进程的订阅 ──────────
	// 建会话命令往往落在另一个桥接进程（host-rpc 连接），它只写文件；持有
	// sessions-index 订阅的本进程（task-index 连接）在快照之后靠这里补推送——
	// host 在握手稳定后不再周期 resync，没有这一环侧栏就永远等不到新会话。
	/** @type {Map<string, Map<string, number>>} topic → sessionId → lastActivityAt（已送达水位）。 */
	const pushedSummaryWatermarks = new Map();
	/**
	 * sessions-index 各 topic 已发帧的 toSeq 水位。host 侧 syncer 对 delta 帧的要求是
	 * fromSeq === 已应用的 indexSeq（zcodeTaskIndexSyncer applySessionsIndexFrame 的 gap
	 * 检测），否则触发 forceSnapshot 重订循环；这里逐 topic 记录 snapshot/delta 的 toSeq
	 * 作为下一帧 fromSeq 的衔接基线（conversationSeq 是全局共享计数器，会被 conversation
	 * topic 的帧推进，不能直接当 fromSeq 用）。
	 */
	const sessionsIndexTopicSeqs = new Map();

	function markSummariesSeen(topic, sessions) {
		const seen = pushedSummaryWatermarks.get(topic) ?? new Map();
		for (const summary of sessions) {
			if (summary && typeof summary.sessionId === "string") {
				seen.set(summary.sessionId, Number(summary.lastActivityAt) || 0);
			}
		}
		pushedSummaryWatermarks.set(topic, seen);
	}

	function pushPersistedUpserts() {
		for (const [topic, subscriptionId] of ctx.v4Subscriptions) {
			if (!topic.startsWith("sessions-index/")) continue;
			const workspaceId = topic.slice("sessions-index/".length);
			const deltas = [];
			const seen = pushedSummaryWatermarks.get(topic);
			for (const summary of persistedSummariesFor(workspaceId, undefined, { afterWatermarks: seen })) {
				deltas.push({ op: "session.upserted", session: summary });
			}
			if (deltas.length === 0) continue;
			const { lastSeq, toSeq } = nextSessionsIndexSeq(topic);
			ctx.notify(
				"v4/conversation/frame",
				makeConversationDeltasFrame({
					topic,
					subscriptionId,
					fromSeq: lastSeq,
					toSeq,
					deltas,
				}),
			);
			sessionsIndexTopicSeqs.set(topic, toSeq);
			markSummariesSeen(topic, deltas.map((d) => d.session));
			log(`sessions-index 跨进程推送 topic=${topic} count=${deltas.length}`);
		}
	}

	if (process.env.STEPCODE_BRIDGE_STATE_WATCH !== "0") {
		// stat 轮询（默认 3s）比 fs.watch 在 Windows 的 rename 替换下更稳；文件通常
		// 不存在（首次运行）时 watchFile 同样安全——创建/变更都会在下一跳被发现。
		watchFile(ctx.STATE_FILE, { interval: 3000 }, (current, previous) => {
			if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
			pushPersistedUpserts();
		});
	}

	/** 向全部 sessions-index 订阅广播 session.upserted delta（fromSeq 衔接各 topic 已应用的 indexSeq）。 */
	function broadcastSessionsIndexUpsert() {
		if (!ctx.primarySession) return;
		for (const [topic, subscriptionId] of ctx.v4Subscriptions) {
			if (!topic.startsWith("sessions-index/")) continue;
			const workspaceId = topic.slice("sessions-index/".length);
			const summary = makePrimarySessionSummary(workspaceId);
			if (!summary) continue;
			const { lastSeq, toSeq } = nextSessionsIndexSeq(topic);
			ctx.notify(
				"v4/conversation/frame",
				makeConversationDeltasFrame({
					topic,
					subscriptionId,
					fromSeq: lastSeq,
					toSeq,
					deltas: [{ op: "session.upserted", session: summary }],
				}),
			);
			sessionsIndexTopicSeqs.set(topic, toSeq);
			markSummariesSeen(topic, [summary]);
		}
	}

	// ── 墓碑（deleted-sessions.json）与会话索引条目管理（P1-01） ─────────────────
	// 设计：userDelete/draftCleanup 在锁内「过滤索引条目 + 登记墓碑 + 写回」一次完成；
	// 墓碑是防复活的第二道防线——索引文件条目删干净后仍可能有跨进程竞态来源（另一
	// 桥接进程恰以被删会话为 primary 时，其内存态 makePrimarySessionSummary 的 live
	// upsert 可能短暂复活条目），persistSessionSummary（写前）与 persistedSummariesFor
	//（读后）两侧都按墓碑过滤，挡住全部持久化来源。
	const TOMBSTONE_FILE = () => join(ctx.STATE_DIR, "deleted-sessions.json");
	const TOMBSTONE_MAX = 500;

	/** 读取墓碑（读失败按空处理——损坏/缺失不阻断正常路径）。 */
	function readTombstones() {
		try {
			const parsed = JSON.parse(readFileSync(TOMBSTONE_FILE(), "utf8"));
			if (parsed && typeof parsed === "object" && parsed.version === 1 && Array.isArray(parsed.sessionIds)) {
				return parsed.sessionIds.filter((id) => typeof id === "string");
			}
		} catch {
			// 首次运行/损坏/并发替换窗口：一律按空态处理。
		}
		return [];
	}

	function tombstoneSet() {
		return new Set(readTombstones());
	}

	function tombstoned(sessionId) {
		return tombstoneSet().has(sessionId);
	}

	/**
	 * 登记墓碑（必须在 withSessionIndexLock 锁内调用，与索引写回同一事务）：最新的在
	 * 最前，FIFO 上限 500（超限淘汰最旧——太久远的删除被复活概率已随索引条目 200 条
	 * 滚动窗口趋近于零）。tmp+rename 原子替换，写失败向上抛（由调用方决定回滚）。
	 */
	function appendTombstone(sessionId) {
		const ids = [...new Set([sessionId, ...readTombstones()])];
		while (ids.length > TOMBSTONE_MAX) ids.pop();
		mkdirSync(ctx.STATE_DIR, { recursive: true });
		const tmp = `${TOMBSTONE_FILE()}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: 1, sessionIds: ids }), "utf8");
		renameSync(tmp, TOMBSTONE_FILE());
	}

	/** 锁内写回索引文件（tmp+rename 原子替换 + worker 侧变更通知）。 */
	function writePersistedWorkspaces(workspaces) {
		mkdirSync(ctx.STATE_DIR, { recursive: true });
		const tmp = `${ctx.STATE_FILE}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: 1, workspaces }), "utf8");
		renameSync(tmp, ctx.STATE_FILE);
		if (ctx.IS_SESSION_WORKER) setImmediate(() => ctx.notify("bridge/sessionIndexChanged", {}));
	}

	/**
	 * renameSession 的索引侧落点：全键遍历（对齐 removeSessionInIndex 先例——摘要可能
	 * 在多个 workspace 键下有条目），命中条目替换 title 并 bump lastActivityAt=Date.now()。
	 * bump 水位是关键：跨进程订阅方（另一桥接进程的 3s watchFile 轮询）按 lastActivityAt
	 * 水位过滤 delta（pushPersistedUpserts），不 bump 的话改名条目会被当作「已送达」
	 * 静默吞掉，跨进程侧栏标题永远停在旧值。
	 * @param {string} sessionId
	 * @param {string} title
	 */
	function renameSessionInIndex(sessionId, title) {
		withSessionIndexLock(ctx.STATE_DIR, () => {
			const workspaces = readPersistedWorkspaces();
			for (const key of Object.keys(workspaces)) {
				const list = workspaces[key];
				if (!Array.isArray(list)) continue;
				workspaces[key] = list.map((item) =>
					item?.sessionId === sessionId ? { ...item, title, lastActivityAt: Date.now() } : item,
				);
			}
			writePersistedWorkspaces(workspaces);
		});
	}

	/**
	 * 从索引移除会话条目（全键过滤）并可选登记墓碑；同一锁内一次写回。
	 * registerTombstone=true 时墓碑与索引过滤是同一事务——任一失败都会让锁操作抛错，
	 * 调用方（session-admin）据此回滚归档、保持「索引未动、任务仍在列表可重试」。
	 * @param {{ registerTombstone?: boolean }} [options]
	 */
	function removeSessionInIndex(sessionId, options = {}) {
		withSessionIndexLock(ctx.STATE_DIR, () => {
			const workspaces = readPersistedWorkspaces();
			for (const key of Object.keys(workspaces)) {
				if (!Array.isArray(workspaces[key])) continue;
				workspaces[key] = workspaces[key].filter((item) => item?.sessionId !== sessionId);
			}
			writePersistedWorkspaces(workspaces);
			if (options.registerTombstone) appendTombstone(sessionId);
		});
	}

	return {
		normalizeWorkspaceKey,
		readPersistedWorkspaces,
		persistSessionSummary,
		persistedSummariesFor,
		persistPrimarySummary,
		deriveSessionTitle,
		makePrimarySessionSummary,
		broadcastSessionsIndexSnapshot,
		pushPersistedUpserts,
		broadcastSessionsIndexUpsert,
		renameSessionInIndex,
		removeSessionInIndex,
		readTombstones,
		appendTombstone,
	};
}
