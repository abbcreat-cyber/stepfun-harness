/**
 * v4 deleteSession 双语义回归（P1-01 intent 分离 + 先归档后改索引 + 墓碑防复活）。
 *
 * 背景（交接 P1-01 / 评审修订）：deleteSession 此前只有「空草稿回收」一种语义——
 * 有正文或运行中一律拒绝；用户主动删除走 adapter deleteTask 只写 task-index（桥接侧
 * 会话正文/附件/工作流 journal 全部留存）。本轮协议 additive 引入 payload.intent：
 * - 缺省=draftCleanup：现行空草稿守卫原样（useDraftSessionPrewarm /
 *   useSavedWorkflowLauncher 两个 payload:{} 调用方语义不变）；
 * - userDelete：用户显式确认后的破坏性全量删除——先归档（正文+journal+附件全部
 *   rename 进 STATE_DIR/trash，任何失败=整体抛错、索引未动、任务仍在列表可重试）→
 *   再锁内改索引+墓碑（写失败 best-effort 回滚归档再抛错）。附件不再物理删、全量可恢复。
 *
 * 本套件钉住（mock 底座活体，launchBridge+--state-dir argv）：
 * 1) 向后兼容：缺省 intent 有正文回 -32000、空草稿缺省回 accepted（守卫不变）；
 * 2) userDelete 成功路径：accepted 后索引全键无条目、conversations 文件消失且
 *    trash/<enc(id)>-<ts>/conversation.json 内容=原正文（含 rows 与 stepSessionFile
 *    引用，原生 step 会话文件不删）、墓碑文件含 sessionId；
 * 3) 附件可恢复：上传 commit 后 userDelete，attachments/<sha256(id)> 不存在且
 *    trash/…/attachments/ 内能读回原文件；
 * 4) 工作流：startSavedWorkflow 产生 workflows/<enc(id)> 后 userDelete，目录被挪入 trash；
 * 5) turnBusy primary 回 -32000；
 * 6) 归档失败可重试契约（高优先）：trash 父目录不可写→整体抛错且索引/正文/附件均
 *    未变动（任务仍在列表）；锁内写失败→回滚归档后正文回原位；
 * 7) 墓碑防复活：删除后再建另一会话触发 persist，session/list 与索引文件均不含被删会话。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBridge, waitForExit } from "./helpers.mjs";

const indexFileOf = (stateDir) => join(stateDir, "sessions-index.json");
const tombstoneFileOf = (stateDir) => join(stateDir, "deleted-sessions.json");
const convFileOf = (stateDir, sessionId) =>
	join(stateDir, "conversations", `${encodeURIComponent(sessionId)}.json`);
const trashRootOf = (stateDir) => join(stateDir, "trash");

/** 在 trash 下定位目标会话的归档目录（名形如 <enc(id)>-<ts>）。 */
function findTrashDir(stateDir, sessionId) {
	const prefix = `${encodeURIComponent(sessionId)}-`;
	const entries = readdirSync(trashRootOf(stateDir), { withFileTypes: true });
	const found = entries.filter((e) => e.isDirectory() && e.name.startsWith(prefix));
	assert.equal(found.length, 1, `trash 下应恰有一个 ${sessionId} 的归档目录：${JSON.stringify(entries.map((e) => e.name))}`);
	return join(trashRootOf(stateDir), found[0].name);
}

function sendCommand(b, id, params) {
	b.send({ id, method: "v4/command", params });
	return b.waitFor((f) => f.id === id, { label: `v4/command ${params.commandId}` });
}

/** 建会话（可选首条消息）并等 ack；firstInput 时一并等 turn.completed。 */
async function createSessionWithTurn(b, sessionId, firstInput) {
	const ack = await sendCommand(b, 1, {
		commandId: `create-${sessionId}`,
		clientId: "delete-suite",
		sessionId,
		type: "createSession",
		payload: firstInput ? { firstInput } : {},
		issuedAt: Date.now(),
	});
	assert.equal(ack.result?.status, "accepted", `createSession ${sessionId} 应被接受`);
	if (firstInput) {
		await b.waitFor(
			(f) => f.params?.type === "turn.completed" && f.params.sessionId === sessionId,
			{ label: `${sessionId} 首条消息 turn.completed` },
		);
		// 终态通知可能早于最后一次落盘；归档比较必须读取已结算的正文，不能与旧的 running 文件比较。
		const deadline = Date.now() + 10000;
		while (true) {
			const saved = JSON.parse(readFileSync(convFileOf(b.stateDir, sessionId), "utf8"));
			if (saved.rows.some(row => row.kind === "turnHeader" && row.state === "completedSuccess")) break;
			if (Date.now() > deadline) throw new Error("等待会话终态落盘超时");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	}
	return ack;
}

async function deleteSession(b, id, sessionId, intent) {
	// commandId 必须带请求序号保证每次唯一——路由层对 v4/command 的响应（含错误）
	// 按 `${sessionId}#${commandId}` 缓存回放（session-router commandReplies），「修复注入
	// 后重试」用例若复用 commandId 会拿到缓存的旧错误，测不到真实重试。
	return sendCommand(b, id, {
		commandId: `del-${sessionId}-${intent ?? "default"}-${id}`,
		clientId: "delete-suite",
		sessionId,
		type: "deleteSession",
		payload: intent ? { intent } : {},
		issuedAt: Date.now(),
	});
}

/** 最小合法 PNG（1x1 透明像素），attachments suite 同款 fixture。 */
const PNG_FIXTURE =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

/** v4/attachment 三步上传并返回 { ref, bytes }。 */
async function uploadAttachment(b, sessionId, connectionId, uploadId) {
	const bytes = Buffer.from(PNG_FIXTURE, "base64");
	const p = {
		sessionId,
		connectionId,
		uploadId,
		fileName: `${uploadId}.png`,
		mime: "image/png",
		totalBytes: bytes.length,
		totalChunks: 1,
		checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
	};
	b.send({ id: 100, method: "v4/attachment/begin", params: p });
	assert.equal((await b.waitFor((f) => f.id === 100, { label: "attachment begin" })).result.state, "staging");
	b.send({ id: 101, method: "v4/attachment/chunk", params: { ...p, chunkIndex: 0, dataBase64: PNG_FIXTURE } });
	assert.equal((await b.waitFor((f) => f.id === 101, { label: "attachment chunk" })).result.nextChunkIndex, 1);
	b.send({ id: 102, method: "v4/attachment/commit", params: p });
	const commit = await b.waitFor((f) => f.id === 102, { label: "attachment commit" });
	return { ref: commit.result.ref, bytes, params: p };
}

/** 桥 AttachmentStore.directory 同款：attachments root/<sha256(sessionId)>。 */
function attachmentDirOf(stateDir, sessionId) {
	return join(stateDir, "attachments", createHash("sha256").update(sessionId).digest("hex"));
}

/** 轮询等索引文件出现（或不再含）目标会话摘要。 */
function waitForIndex(assertion, stateDir, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const parsed = JSON.parse(readFileSync(indexFileOf(stateDir), "utf8"));
			if (assertion(parsed)) return parsed;
		} catch {
			// 尚未写入/并发替换窗口：继续轮询。
		}
		if (Date.now() > deadline) throw new Error(`等待索引状态断言超时`);
	}
}

function indexHasSession(parsed, sessionId) {
	return Object.values(parsed?.workspaces ?? {}).some((list) =>
		Array.isArray(list) ? list.some((s) => s?.sessionId === sessionId) : false,
	);
}

function readTombstones(stateDir) {
	return JSON.parse(readFileSync(tombstoneFileOf(stateDir), "utf8")).sessionIds;
}

test("delete：向后兼容钉住——缺省 intent 有正文回 -32000、空草稿缺省回 accepted", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-del-compat-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-del-compat-state-"));
	const withRows = "step-session-del-compat-rows";
	const draft = "step-session-del-compat-draft";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		// 有正文：缺省 intent（draftCleanup）沿用守卫——拒绝。
		await createSessionWithTurn(b, withRows, { text: "有正文的会话" });
		const rejected = await deleteSession(b, 10, withRows, undefined);
		assert.equal(rejected.error?.code, -32000, `有正文缺省删除应回 -32000：${JSON.stringify(rejected)}`);
		assert.match(rejected.error?.message ?? "", /空白草稿/);

		// 空草稿：缺省 intent 回 accepted（prewarmer/launcher 守卫不变），且补写墓碑。
		const createDraft = await sendCommand(b, 11, {
			commandId: `create-${draft}`,
			clientId: "delete-suite",
			sessionId: draft,
			type: "createSession",
			payload: {},
			issuedAt: Date.now(),
		});
		assert.equal(createDraft.result?.status, "accepted");
		const accepted = await deleteSession(b, 12, draft, undefined);
		assert.equal(accepted.result?.status, "accepted", `空草稿缺省删除应 accepted：${JSON.stringify(accepted)}`);
		assert.ok(!existsSync(convFileOf(stateDir, draft)), "空草稿清理后 conversations 文件应消失");
		assert.ok(readTombstones(stateDir).includes(draft), "空草稿清理也应写墓碑（防复活）");
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（delete 向后兼容）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("delete：userDelete 成功路径——先归档后改索引，正文/journal/墓碑全部落位", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-del-user-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-del-user-state-"));
	const sessionId = "step-session-del-user";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "将被全量删除的会话正文" });
		const convBefore = JSON.parse(readFileSync(convFileOf(stateDir, sessionId), "utf8"));
		assert.ok(Array.isArray(convBefore.rows) && convBefore.rows.length > 0, "删除前应有正文 rows");
		assert.equal(typeof convBefore.session.stepSessionFile, "string", "删除前 session 应记录原生 step 会话文件引用");
		waitForIndex((parsed) => indexHasSession(parsed, sessionId), stateDir);

		const ack = await deleteSession(b, 10, sessionId, "userDelete");
		assert.equal(ack.result?.status, "accepted", `userDelete 应被接受：${JSON.stringify(ack)}`);

		// 索引全键无条目；conversations 文件消失；墓碑含 sessionId。
		const parsed = JSON.parse(readFileSync(indexFileOf(stateDir), "utf8"));
		assert.equal(indexHasSession(parsed, sessionId), false, "sessions-index 全键应无该会话条目");
		assert.ok(!existsSync(convFileOf(stateDir, sessionId)), "userDelete 后 conversations 原位文件应消失");

		// trash 归档可恢复：conversation.json 内容=原正文（含 rows 与 stepSessionFile 引用）。
		const trashDir = findTrashDir(stateDir, sessionId);
		const archived = JSON.parse(readFileSync(join(trashDir, "conversation.json"), "utf8"));
		assert.deepEqual(archived, convBefore, "trash/conversation.json 应为原正文的完整归档（含 rows 与 stepSessionFile）");

		// 墓碑防复活。
		assert.deepEqual(readTombstones(stateDir), [sessionId]);
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（delete userDelete 成功）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("delete：附件可恢复——userDelete 后 attachments 原位目录消失、trash 内可读回原文件", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-del-attach-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-del-attach-state-"));
	const sessionId = "step-session-del-attach";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "带附件的会话" });
		const { ref, bytes } = await uploadAttachment(b, sessionId, "conn-del-attach", "upload-del-attach");
		const attachDir = attachmentDirOf(stateDir, sessionId);
		assert.ok(existsSync(attachDir), "删除前附件目录应在原位");
		const key = ref.slice("step-attachment:".length);

		const ack = await deleteSession(b, 10, sessionId, "userDelete");
		assert.equal(ack.result?.status, "accepted");

		assert.ok(!existsSync(attachDir), "userDelete 后 attachments/<sha256(id)> 原位目录应消失");
		const trashDir = findTrashDir(stateDir, sessionId);
		assert.deepEqual(
			readFileSync(join(trashDir, "attachments", `${key}.bin`), "utf8"),
			bytes.toString("utf8"),
			"trash/…/attachments/ 内应能读回原文件内容",
		);
		// 元数据 JSON 一并归档（重放/审计可用）。
		assert.ok(existsSync(join(trashDir, "attachments", `${key}.json`)), "附件元数据 JSON 应一并归档");
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（delete 附件可恢复）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("delete：工作流——startSavedWorkflow 产生 workflows 目录后 userDelete，目录被挪入 trash", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-del-wf-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-del-wf-state-"));
	const sessionId = "step-session-del-wf";
	const workflowName = "trash-test";
	// 已保存工作流（serializeSavedWorkflow 格式：frontmatter 块注释 + dwf 脚本正文）。
	// 保存位置：project scope 的 <cwd>/.zcode/workflows/<name>.dwf.ts（saved-workflows store.ts）。
	mkdirSync(join(workspaceDir, ".zcode", "workflows"), { recursive: true });
	writeFileSync(
		join(workspaceDir, ".zcode", "workflows", `${workflowName}.dwf.ts`),
		`/* zcode-workflow\ndescription: ${workflowName}\n*/\nreturn {ok:true};\n`,
		"utf8",
	);
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "启动工作流的会话" });
		const ack = await sendCommand(b, 10, {
			commandId: "cmd-del-wf-launch",
			clientId: "delete-suite",
			sessionId,
			type: "startSavedWorkflow",
			payload: { name: workflowName, args: {} },
			issuedAt: Date.now(),
		});
		assert.equal(ack.result?.status, "accepted", `startSavedWorkflow 应编译通过并 accepted：${JSON.stringify(ack)}`);
		assert.ok(typeof ack.result?.result?.runId === "string", "ack 应携带 runId（目录创建发生在 service() 装配期）");
		const workflowDir = join(stateDir, "workflows", encodeURIComponent(sessionId));
		assert.ok(existsSync(workflowDir), "启动后 workflows/<enc(id)> 目录应存在");

		const del = await deleteSession(b, 11, sessionId, "userDelete");
		assert.equal(del.result?.status, "accepted", `userDelete 应先释放 journal sqlite 句柄再挪目录（Windows 句柄序）：${JSON.stringify(del)}`);
		assert.ok(!existsSync(workflowDir), "userDelete 后 workflows 原位目录应消失");
		const trashDir = findTrashDir(stateDir, sessionId);
		assert.ok(statSync(join(trashDir, "workflows", "workflow-runs.sqlite")).isFile(), "工作流 journal sqlite 应完整挪入 trash（可恢复/可审计）");
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（delete 工作流）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("delete：turnBusy primary 回 -32000（运行中先停止再删除）", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-del-busy-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-del-busy-state-"));
	const sessionId = "step-session-del-busy";
	// --delay 200：拉长 turn 剧本（事件间 200ms），让 turn.started 之后仍有充足窗口发出删除。
	// 桥接未知 argv 不会传给 mock；用 mock 支持的环境参数控制事件间隔。
	const b = launchBridge([], { STEP_MOCK_DELAY_MS: "200" }, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "第一轮短消息" });
		const send = await sendCommand(b, 10, {
			commandId: "cmd-del-busy-send",
			clientId: "delete-suite",
			sessionId,
			type: "sendText",
			payload: { text: "正在运行的第二轮消息" },
			issuedAt: Date.now(),
		});
		assert.equal(send.result?.status, "accepted");
		// 等 turn.started：agent_start 已处理（turnBusy=true 已落），turn 尚未完成。
		// waitFor 会匹配已缓存帧；必须选中第二轮，不能拿第一轮的 started 验证“运行中”。
		const started = await b.waitFor((f) => f.params?.type === "turn.started" && f.params.sessionId === sessionId && f.params.payload?.input === "正在运行的第二轮消息", { timeoutMs: 20000, label: "第二轮 turn.started" });
		const rejected = await deleteSession(b, 11, sessionId, "userDelete");
		assert.equal(rejected.error?.code, -32000, `turnBusy 时 userDelete 应回 -32000：${JSON.stringify(rejected)}`);
		assert.match(rejected.error?.message ?? "", /运行中/);
		// 等本轮结束再收尾（turn 完成后桥才进入可退出状态，避免 kill 撕掉剧本进程组）。
		await b.waitFor((f) => f.params?.type === "turn.completed" && f.params.sessionId === sessionId && f.params.turnId === started.params.turnId, { timeoutMs: 30000, label: "第二轮 turn.completed" });
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（delete turnBusy）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("delete：归档失败可重试——trash 父目录不可写时整体抛错、索引/正文/附件均未变动、修复后重试成功", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-del-retry-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-del-retry-state-"));
	const sessionId = "step-session-del-retry";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "归档失败注入用例的正文" });
		const { ref, bytes } = await uploadAttachment(b, sessionId, "conn-del-retry", "upload-del-retry");
		const attachDir = attachmentDirOf(stateDir, sessionId);
		const convBefore = readFileSync(convFileOf(stateDir, sessionId), "utf8");
		const indexBefore = readFileSync(indexFileOf(stateDir), "utf8");

		// 注入归档失败：把 trash 父路径做成普通文件（mkdirSync ENOTDIR，稳定可制造）。
		writeFileSync(trashRootOf(stateDir), "not a directory", "utf8");
		const failed = await deleteSession(b, 10, sessionId, "userDelete");
		assert.ok(failed.error, "归档失败必须如实抛错");
		assert.equal(failed.error.code, -32000);
		assert.match(failed.error.message ?? "", /归档|删除/);

		// 零改动契约：正文/附件/索引均未变动（任务仍在列表可重试）。
		assert.equal(readFileSync(convFileOf(stateDir, sessionId), "utf8"), convBefore, "归档失败时正文不得变动");
		assert.equal(readFileSync(indexFileOf(stateDir), "utf8"), indexBefore, "归档失败时索引不得变动");
		assert.ok(existsSync(attachDir), "归档失败时附件目录不得变动");
		const parsed = JSON.parse(readFileSync(indexFileOf(stateDir), "utf8"));
		assert.ok(indexHasSession(parsed, sessionId), "归档失败时索引条目应保留");

		// 修复 trash 后重试应当成功（失败不留半状态、全量可恢复）。
		rmSync(trashRootOf(stateDir), { force: true });
		mkdirSync(trashRootOf(stateDir), { recursive: true });
		const retried = await deleteSession(b, 11, sessionId, "userDelete");
		assert.equal(retried.result?.status, "accepted", `重试应成功：${JSON.stringify(retried)}`);
		assert.ok(!existsSync(convFileOf(stateDir, sessionId)));
		const trashDir = findTrashDir(stateDir, sessionId);
		const key = ref.slice("step-attachment:".length);
		assert.deepEqual(readFileSync(join(trashDir, "attachments", `${key}.bin`), "utf8"), bytes.toString("utf8"), "重试成功后附件应进 trash");
	} finally {
		// trash 若仍是普通文件（断言提前失败路径），先移除再递归清理。
		try { rmSync(trashRootOf(stateDir), { force: true }); } catch { /* 尽力 */ }
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（delete 归档失败重试）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("delete：锁内写失败→回滚归档（正文回原位、trash 无有效残留、条目保留）", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-del-rollback-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-del-rollback-state-"));
	const sessionId = "step-session-del-rollback";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, sessionId, { text: "锁内写失败回滚用例的正文" });
		const convBefore = readFileSync(convFileOf(stateDir, sessionId), "utf8");

		// 注入「索引写失败」：把 sessions-index.json 换成目录（Windows 上 rename 不能把
		// 文件替换成目录，锁内 writePersistedWorkspaces 的 renameSync 必失败——chmod 只读
		// 的手段经探针证实对 node:sqlite 无效，故改用文件系统语义）。注入前 turn 已完成、
		// primary idle，无并发 persist 写入窗口。锁文件本身保持可用（锁获取成功、写回失败
		// 才是要测的路径）。
		const lockFile = join(stateDir, "sessions-index-lock.sqlite");
		assert.ok(existsSync(lockFile), "前置：锁文件应已存在");
		const indexBefore = readFileSync(indexFileOf(stateDir), "utf8");
		rmSync(indexFileOf(stateDir));
		mkdirSync(indexFileOf(stateDir));
		try {
			const failed = await deleteSession(b, 10, sessionId, "userDelete");
			assert.ok(failed.error, "锁内写失败必须如实抛错（deleteSession 整体失败）");
			assert.equal(failed.error.code, -32000, JSON.stringify(failed));
			// 回滚归档：正文回到原位且内容逐字节一致；墓碑未落（锁内事务在写回处失败，
			// appendTombstone 尚未执行——索引进度未推进的完整证据）。
			assert.equal(readFileSync(convFileOf(stateDir, sessionId), "utf8"), convBefore, "锁失败回滚后正文应逐字节复原");
			assert.equal(existsSync(tombstoneFileOf(stateDir)), false, "锁失败时墓碑不得落盘（索引进度未推进）");
			// trash 残留的归档目录内不应有已搬回的正文副本（回滚后 conversation.json 回原位）。
			if (existsSync(trashRootOf(stateDir))) {
				for (const entry of readdirSync(trashRootOf(stateDir), { withFileTypes: true })) {
					const convPath = join(trashRootOf(stateDir), entry.name, "conversation.json");
					assert.ok(!existsSync(convPath), `回滚后 trash 内不应残留正文副本：${convPath}`);
				}
			}
		} finally {
			// 恢复索引文件形态（目录→注入前的原内容），供下方重试与 finally 清理使用。
			rmSync(indexFileOf(stateDir), { recursive: true, force: true });
			writeFileSync(indexFileOf(stateDir), indexBefore, "utf8");
		}

		// 恢复索引文件形态后重试成功（失败不留半状态、全量可恢复）。
		const retried = await deleteSession(b, 11, sessionId, "userDelete");
		assert.equal(retried.result?.status, "accepted", `索引恢复后重试应成功：${JSON.stringify(retried)}`);
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（delete 锁内回滚）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("delete：墓碑防复活——删除后再建另一会话触发 persist，session/list 与索引文件均不含被删会话", async () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "bridge-del-tomb-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "bridge-del-tomb-state-"));
	const deletedId = "step-session-del-tomb-dead";
	const survivorId = "step-session-del-tomb-alive";
	const b = launchBridge([], {}, { stateDir, cwd: workspaceDir });
	try {
		await createSessionWithTurn(b, deletedId, { text: "将被删除并验证不复活" });
		await createSessionWithTurn(b, survivorId, { text: "删除后仍存活的会话" });
		const ack = await deleteSession(b, 10, deletedId, "userDelete");
		assert.equal(ack.result?.status, "accepted");

		// 再发一轮消息到幸存会话：agent_start/agent_settled 各触发一次 persistPrimarySummary
		// （内存 live upsert + 持久化），被删会话不得经任何路径复活。
		const send = await sendCommand(b, 11, {
			commandId: "cmd-del-tomb-send",
			clientId: "delete-suite",
			sessionId: survivorId,
			type: "sendText",
			payload: { text: "触发 persist 的后续消息" },
			issuedAt: Date.now(),
		});
		assert.equal(send.result?.status, "accepted");
		await b.waitFor(
			(f) => f.params?.type === "turn.completed" && f.params.sessionId === survivorId,
			{ label: "幸存会话 turn.completed" },
		);

		// session/list 与索引文件均不含被删会话；墓碑仍在。
		b.send({ id: 12, method: "session/list", params: { workspace: { workspacePath: workspaceDir, workspaceKey: workspaceDir } } });
		const listed = await b.waitFor((f) => f.id === 12, { label: "session/list" });
		const listedIds = listed.result.sessions.map((s) => s.sessionId);
		assert.equal(listedIds.includes(deletedId), false, `session/list 不得含被删会话：${JSON.stringify(listedIds)}`);
		assert.equal(listedIds.includes(survivorId), true, `session/list 应含幸存会话：${JSON.stringify(listedIds)}`);
		const parsed = JSON.parse(readFileSync(indexFileOf(stateDir), "utf8"));
		assert.equal(indexHasSession(parsed, deletedId), false, "索引文件不得含被删会话条目");
		assert.ok(readTombstones(stateDir).includes(deletedId), "墓碑应持续在位");
	} finally {
		b.child.stdin.end();
		await waitForExit(b.child, { label: "bridge 退出（delete 墓碑防复活）" });
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
});
