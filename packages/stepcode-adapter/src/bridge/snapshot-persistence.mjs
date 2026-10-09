import { log } from "./logging.mjs";

const retryDelays = [25, 50, 100, 200, 400];
const transientCodes = new Set(["EPERM", "EACCES", "EBUSY"]);
const ioCodes = new Set([...transientCodes, "ENOSPC", "EIO", "EROFS", "ENOENT"]);

/** 快照是内存状态的投影；文件被占用不能阻断中断指令或实时终态帧。 */
export function createSnapshotPersistence(ctx) {
 let timer, sessionId, attempt = 0, reported = false;
 function reset() {
  clearTimeout(timer);timer = undefined;attempt = 0;reported = false;
 }
 return function persistSnapshot() {
  const current = ctx.primarySession?.sessionId;
  if (current !== sessionId) { reset();sessionId = current; }
  if (!current) return;
  try {
   ctx.persistConversation();reset();
  } catch (error) {
   if (!ioCodes.has(error.code)) throw error;
   if (!reported) {
    log(`conversation snapshot save failed (${error.code}); live state remains available: ${current}`);
    reported = true;
   }
   if (!transientCodes.has(error.code) || timer) return;
   if (attempt >= retryDelays.length) {
    if (attempt === retryDelays.length) log(`conversation snapshot save retry exhausted: ${current}`);
    attempt = retryDelays.length + 1;
    return;
   }
   // 只重试同一 owner 的最新快照，不缓存旧序列化内容，避免恢复后覆盖新状态。
   timer = setTimeout(() => {
    timer = undefined;
    if (ctx.primarySession?.sessionId !== current) { reset();return; }
    persistSnapshot();
   }, retryDelays[attempt++]);
  }
 };
}
