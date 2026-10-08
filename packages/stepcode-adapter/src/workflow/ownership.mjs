import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/** 独立运行租约，不复制 journal 状态；SQLite 写事务避免两个桥接同时接管同一 run。 */
export class WorkflowOwnership {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owners (run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL)",
    );
  }
  claim(runId, onlyAbandoned = false) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT pid FROM owners WHERE run_id=?").get(runId);
      if (onlyAbandoned && !old) {
        this.db.exec("COMMIT");
        return null;
      }
      if (old) {
        let alive = true;
        try {
          process.kill(old.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") alive = false;
        }
        // PID 被复用或访问被拒绝时，不能证明旧 owner 已死，所以拒绝接管。
        if (alive) {
          this.db.exec("COMMIT");
          return null;
        }
      }
      const nonce = randomUUID();
      this.db
        .prepare("INSERT OR REPLACE INTO owners(run_id,pid,nonce) VALUES(?,?,?)")
        .run(runId, process.pid, nonce);
      this.db.exec("COMMIT");
      return () =>
        this.db.prepare("DELETE FROM owners WHERE run_id=? AND nonce=?").run(runId, nonce);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
