import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

test("历史正文回填保留元数据，拒绝过期读取和覆盖已有正文", async () => {
  const base = process.env.STEP_TEST_ROOT || join(tmpdir(), "stepcode-search-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "index-"));
  const path = root + "/tasks.sqlite", repo = new TaskIndexRepo(path);
  const meta = { taskId: "history", traceId: "history-trace", workspacePath: root, title: "用户标题", createdAt: 1, updatedAt: 2, mode: "build" as const, provider: "glm" as const };
  try {
    await repo.syncTaskMeta({ meta });
    const revision = await repo.getSearchBackfillRevision(meta);
    assert.equal(revision, 2);
    await repo.syncTaskMeta({ meta: { ...meta, updatedAt: 3 } });
    await repo.backfillSearchText({ ...meta, expectedUpdatedAt: 2, searchableText: "旧分支" });
    assert.equal(await repo.getSearchBackfillRevision(meta), 3);
    const d = new DatabaseSync(path, { readOnly: true });
    try {
      const before = d.prepare("SELECT * FROM tasks WHERE task_id=?").get(meta.taskId);
      await repo.backfillSearchText({ ...meta, expectedUpdatedAt: 3, searchableText: "正确正文" });
      await repo.backfillSearchText({ ...meta, expectedUpdatedAt: 3, searchableText: "不能覆盖" });
      assert.equal(await repo.getSearchBackfillRevision(meta), null);
      const after = d.prepare("SELECT * FROM tasks WHERE task_id=?").get(meta.taskId);
      assert.deepEqual({ ...after }, { ...before, searchable_text: "正确正文" });
    } finally { d.close(); }
  } finally { repo.close(); }
});
