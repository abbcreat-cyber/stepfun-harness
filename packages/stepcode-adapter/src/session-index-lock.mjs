import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** 跨会话进程只串行化共享索引的短写入，不锁模型执行或会话文件。 */
export function withSessionIndexLock(directory, operation) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "sessions-index-lock.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
