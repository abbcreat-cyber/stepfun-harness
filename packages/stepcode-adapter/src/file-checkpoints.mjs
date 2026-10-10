import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, unlink, mkdir, rename } from "node:fs/promises";
import { resolve, dirname, parse } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export const CHECKPOINT = "desktop-file-checkpoint-v1";
export const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");

export async function readImage(path, { includeData = true } = {}) {
  // 回退不能沿符号链接写到另一位置；父目录 junction 同样必须拒绝。
  let current = path;
  while (current !== parse(current).root) {
    const info = await lstat(current).catch(e => { if (e.code !== "ENOENT") throw e; });
    if (info?.isSymbolicLink()) throw new Error("unsupported_checkpoint: symbolic link");
    current = dirname(current);
  }
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("unsupported_checkpoint: file type or size");
    const data = await readFile(path);
    // 冲突检查只需要最新哈希；完整快照仍供撤销/回滚使用，避免无用的 Base64 字符串。
    return { hash: hashBytes(data), ...(includeData ? { data: data.toString("base64") } : {}) };
  } catch (error) {
    if (error.code === "ENOENT") return { hash: "missing", data: null };
    throw error;
  }
}

export async function putImage(path, image, expectedHash) {
  const expected = expectedHash ?? (await readImage(path, { includeData: false })).hash;
  async function mutate(operation) {
    for (let attempt = 0; ; attempt++) {
      if ((await readImage(path, { includeData: false })).hash !== expected) throw new Error("文件在撤销期间发生变化，请重新预览");
      try { await operation(); return; }
      catch (error) {
        // Windows 预览/索引读取的共享锁可能短暂阻止原子替换；不删除原文件，
        // 仅有界重试，每次重查哈希，避免等待期间覆盖新的外部内容。
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
        await delay(20 * 2 ** attempt);
      }
    }
  }
  if (image.data === null) await mutate(() => unlink(path).catch(e => { if (e.code !== "ENOENT") throw e; }));
  else {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.rewind-${randomUUID()}.tmp`;
    try { await writeFile(temp, Buffer.from(image.data, "base64"), { flag: "wx" }); await mutate(() => rename(temp, path)); }
    finally { await unlink(temp).catch(e => { if (e.code !== "ENOENT") throw e; }); }
  }
}

/** 原生扩展侧记录。每次调用独立日志；并发同路径不能假装成安全串行修改。 */
export function registerFileCheckpoints(pi) {
  const pending = new Map();
  // 新用户轮已与旧执行轮隔离；中断留下的内存记录不能给新写入打 overlap。
  // 不补造旧记录的 after，历史中无法证明完成的 checkpoint 仍然拒绝撤销。
  pi.on("before_agent_start", () => pending.clear());
  pi.on("tool_call", async (event, ctx) => {
    if (!["write_file", "edit_file", "write", "edit", "run_command", "bash", "powershell"].includes(event.toolName)) return;
    const user = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message?.role === "user");
    if (!user) return;
    const ignored = ["run_command", "bash", "powershell"].includes(event.toolName);
    const raw = event.input?.path ?? event.input?.file_path;
    const rawPath = typeof raw === "string" && /^~[\\/]/.test(raw) ? resolve(homedir(), raw.slice(2)) : raw;
    const record = { userId: user.id, toolCallId: event.toolCallId, toolName: event.toolName,
      path: ignored ? "(shell)" : resolve(ctx.cwd, rawPath || "."), ignored };
    if (!ignored) {
      try { record.before = await readImage(record.path); }
      catch (e) { record.error = e.message; }
      if (event.input?.then_run) record.error = "unsupported_checkpoint: tool also ran a shell command";
      for (const other of pending.values()) if (process.platform === "win32" ? other.path.toLowerCase() === record.path.toLowerCase() : other.path === record.path) {
        other.overlap = true; record.overlap = true;
      }
    }
    pending.set(event.toolCallId, record);
    pi.appendEntry(CHECKPOINT, { ...record, phase: "before" });
  });
  pi.on("tool_result", async event => {
    const record = pending.get(event.toolCallId);
    if (!record) return;
    pending.delete(event.toolCallId);
    if (!record.ignored) {
      try { record.afterImage = await readImage(record.path); record.after = record.afterImage.hash; }
      catch (e) { record.error = e.message; }
    }
    pi.appendEntry(CHECKPOINT, { ...record, phase: "after" });
  });
}

export function checkpointsFor(entries, userId) {
  const calls = new Map();
  for (const entry of entries) if (entry.customType === CHECKPOINT && entry.data?.userId === userId)
    calls.set(entry.data.toolCallId, entry.data);
  const paths = new Map();
  for (const call of calls.values()) {
    const file = paths.get(call.path) ?? { path: call.path, calls: [] };
    file.calls.push(call); paths.set(call.path, file);
  }
  return [...paths.values()];
}

export async function checkpointPreview(files) {
  const preview = { canApply: false, ignoredFiles: [], safeFiles: [], unsafeFiles: [] };
  for (const file of files) {
    const calls = file.calls, first = calls[0], last = calls.at(-1);
    const common = { path: file.path, operationCount: calls.length, toolNames: [...new Set(calls.map(c => c.toolName))] };
    if (first.ignored) { preview.ignoredFiles.push({ ...common, reason: "bash_ignored" }); continue; }
    let reason, currentHash;
    if (calls.some(c => !c.before || c.after === undefined)) reason = "checkpoint_missing";
    else if (calls.some((c, i) => c.error || c.overlap || (i && calls[i - 1].after !== c.before.hash))) reason = "unsupported_checkpoint";
    else {
      try { currentHash = (await readImage(file.path, { includeData: false })).hash; if (currentHash !== last.after) reason = "external_modified"; }
      catch { reason = "file_read_failed"; }
    }
    if (reason) preview.unsafeFiles.push({ ...common, reason, ...(currentHash ? { currentHash } : {}), ...(last.after ? { expectedHash: last.after } : {}) });
    else if (first.before.hash !== last.after) preview.safeFiles.push({ ...common, action: first.before.data === null ? "delete" : "restore" });
  }
  preview.canApply = preview.safeFiles.length > 0 && preview.unsafeFiles.length === 0;
  return preview;
}

export function checkpointChanges(files) {
  const lines = data => data == null || data === "" ? [] : Buffer.from(data, "base64").toString("utf8").replace(/\n$/, "").split("\n");
  const items = files.filter(f => !f.calls[0].ignored && f.calls[0].before?.hash !== f.calls.at(-1).after).map(file => {
    const before = lines(file.calls[0].before?.data), after = lines(file.calls.at(-1).afterImage?.data);
    let start = 0, end = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    while (end < before.length - start && end < after.length - start && before.at(-end - 1) === after.at(-end - 1)) end++;
    const removed = before.slice(start, before.length - end), added = after.slice(start, after.length - end);
    return { path: file.path, additions: added.length, deletions: removed.length, writeCount: file.calls.length,
      toolNames: [...new Set(file.calls.map(c => c.toolName))],
      patches: file.calls[0].before && file.calls.at(-1).afterImage ? [{ oldStart: start + 1, oldLines: removed.length, newStart: start + 1, newLines: added.length,
        lines: [...removed.map(line => "-" + line), ...added.map(line => "+" + line)] }] : [] };
  });
  return { files: items.length, additions: items.reduce((n, f) => n + f.additions, 0), deletions: items.reduce((n, f) => n + f.deletions, 0), items };
}

export async function applyCheckpoints(files) {
  const preview = await checkpointPreview(files);
  if (!preview.canApply) return { applied: false, preview };
  const changed = [];
  try {
    for (const item of preview.safeFiles) {
      const file = files.find(f => f.path === item.path), current = await readImage(file.path);
      if (current.hash !== file.calls.at(-1).after) throw new Error("文件在预览后发生变化，请重新预览");
      await putImage(file.path, file.calls[0].before, current.hash);
      changed.push({ path: file.path, before: current, restored: file.calls[0].before.hash });
    }
  } catch (error) {
    await undo(); throw error;
  }
  async function undo() {
    for (const file of [...changed].reverse()) {
      if ((await readImage(file.path, { includeData: false })).hash !== file.restored) throw new Error("回退恢复期间文件已被外部修改；保留快照，请人工检查");
      await putImage(file.path, file.before, file.restored);
    }
  }
  return { applied: true, preview, undo };
}
