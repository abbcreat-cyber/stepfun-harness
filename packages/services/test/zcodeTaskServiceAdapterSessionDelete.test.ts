/**
 * deleteTask/deleteArchivedTask(s) 的 v4 deleteSession 接线单测（P1-01 services 侧）。
 *
 * 背景（评审修订）：sendConversationCommandV4 此前无任何社区门控——若 adapter 无条件
 * 发送 deleteSession，官方 CLI 也会收到该命令（zod 非 strict 惯例会剥离未知键 intent，
 * 官方按其原生语义删空草稿语义处理），破坏官方零波及约束。因此发送侧必须先过
 * isStepCommunityBackendActive（STEP_BACKEND=stepcode-local），官方模式零发送。
 *
 * 顺序契约（与桥接「先归档后索引」同构的端到端可重试链）：社区模式下先 v4 后
 * task-index 墓碑——v4 失败（非 -32002）则 deleteTask 抛错、task-index 未动、任务仍在
 * 列表可重试；-32002（桥接无本地记录）视为幂等已删、墓碑照落。
 *
 * 运行方式（services 包惯例，见 nonCliAcpRetirement.test.ts / R5 状态文档）：
 *   cd packages/services && npx tsx --test test/zcodeTaskServiceAdapterSessionDelete.test.ts
 * （测试内 STEP_BACKEND 的设置/复原用 finally 兜底；本文件全用 fixture 假数据，无真实凭据。）
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import type { IZCodeTaskService } from "../src/session/zcodeTaskService.js";

const STEP_BACKEND_KEY = "STEP_BACKEND";
const STEP_BACKEND_COMMUNITY = "stepcode-local";

const metaOf = (taskId: string, workspacePath: string) => ({
  taskId,
  traceId: `trace-${taskId}`,
  title: `标题 ${taskId}`,
  workspacePath,
  workspaceIdentity: undefined,
  workspaceKey: undefined,
  mode: "build" as const,
  provider: "glm" as const,
  createdAt: 1,
  updatedAt: 2,
});

async function createHarness(options: {
  repoPath: string;
  /** v4 响应（默认 accepted；抛错即模拟桥接侧失败）。 */
  v4Response?: (envelope: { type: string; sessionId: string | null; payload: unknown }) => Promise<CommandAck>;
}) {
  const seq = { next: 0 };
  const v4Calls: Array<{ order: number; envelope: { type: string; sessionId: string | null; payload: unknown } }> = [];
  const repoCalls: Array<{ order: number; name: string }> = [];

  class RecordingTaskIndexRepo extends TaskIndexRepo {
    constructor(path: string) {
      super(path);
    }
    override async updateTaskState(params: Parameters<TaskIndexRepo["updateTaskState"]>[0]) {
      seq.next += 1;
      repoCalls.push({ order: seq.next, name: "updateTaskState" });
      return super.updateTaskState(params);
    }
    override async deleteArchivedTask(params: Parameters<TaskIndexRepo["deleteArchivedTask"]>[0]) {
      seq.next += 1;
      repoCalls.push({ order: seq.next, name: "deleteArchivedTask" });
      return super.deleteArchivedTask(params);
    }
  }

  const repo = new RecordingTaskIndexRepo(options.repoPath);
  const v4Response =
    options.v4Response ??
    (async () => ({ commandId: "ack", status: "accepted", revisionAtDecision: 1 }) satisfies CommandAck);
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const disposable = () => ({ dispose() {} });
  const service = createZCodeTaskServiceAdapter({
    taskIndexRepo: repo,
    zcodeAgentService: {
      async sendConversationCommandV4(params: unknown) {
        const record = params as {
          envelope: { type: string; sessionId: string | null; payload: unknown };
        };
        seq.next += 1;
        v4Calls.push({ order: seq.next, envelope: record.envelope });
        return v4Response(record.envelope);
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      emitWorkspaceTaskListChanged: () => {},
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });

  return {
    service,
    repo,
    v4Calls,
    repoCalls,
    /** 同一计数器上的全局序号：v4 发送 vs repo 墓碑写入。 */
    async dispose() {
      service.disposeAll();
      repo.close();
    },
  };
}

/** 社区/官方模式切换的 try/finally 包装（STEP_BACKEND 复原保证不泄漏到其它用例）。 */
async function withBackendMode(
  mode: "community" | "official",
  body: () => Promise<void>,
): Promise<void> {
  const previous = process.env[STEP_BACKEND_KEY];
  if (mode === "community") {
    process.env[STEP_BACKEND_KEY] = STEP_BACKEND_COMMUNITY;
  } else {
    delete process.env[STEP_BACKEND_KEY];
  }
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env[STEP_BACKEND_KEY];
    } else {
      process.env[STEP_BACKEND_KEY] = previous;
    }
  }
}

test("社区模式 deleteTask：先 v4 deleteSession(intent=userDelete) 后 task-index 墓碑写入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-v4-del-order-"));
  const harness = await createHarness({ repoPath: join(dir, "tasks.sqlite") });
  try {
    await withBackendMode("community", async () => {
      const meta = metaOf("task-order-1", "/workspace/order");
      await harness.repo.syncTaskMeta({ meta });
      await (harness.service as IZCodeTaskService).deleteTask(meta);
      assert.equal(harness.v4Calls.length, 1, "deleteTask 应恰好发送一次 v4 deleteSession");
      const call = harness.v4Calls[0]!;
      assert.equal(call.envelope.type, "deleteSession");
      assert.equal(call.envelope.sessionId, "task-order-1");
      assert.deepEqual(
        (call.envelope.payload as Record<string, unknown> | null) ?? {},
        { intent: "userDelete" },
        "payload 必须携带 intent=userDelete（桥接按它分流全量删除）",
      );
      const repoWrite = harness.repoCalls.find((c) => c.name === "updateTaskState");
      assert.ok(repoWrite, "task-index 墓碑写入必须发生");
      assert.ok(
        call.order < repoWrite.order,
        `v4 发送（全局序号=${call.order}）必须先于 task-index 墓碑写入（${repoWrite.order}）`,
      );
    });
  } finally {
    await harness.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("官方模式（无 STEP_BACKEND）：sendConversationCommandV4 零发送（门控根绝官方波及）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-v4-del-official-"));
  const harness = await createHarness({ repoPath: join(dir, "tasks.sqlite") });
  try {
    await withBackendMode("official", async () => {
      const meta = metaOf("task-official-1", "/workspace/official");
      await harness.repo.syncTaskMeta({ meta });
      await (harness.service as IZCodeTaskService).deleteTask(meta);
      assert.equal(harness.v4Calls.length, 0, "官方模式必须零发送（官方 CLI 会按其原生语义处理 deleteSession）");
      // 官方模式行为保持不变：仍然直接落 task-index 墓碑。
      assert.ok(
        harness.repoCalls.some((c) => c.name === "updateTaskState"),
        "官方模式 deleteTask 仍应直接写 task-index 墓碑（既有行为不变）",
      );
    });
  } finally {
    await harness.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("v4 失败（非 -32002）：deleteTask 抛错且 task-index 未写 deleted（任务仍在列表可重试）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-v4-del-fail-"));
  const harness = await createHarness({
    repoPath: join(dir, "tasks.sqlite"),
    v4Response: async () => {
      throw Object.assign(new Error("桥接会话运行中，请先停止后再删除"), { code: -32000 });
    },
  });
  try {
    await withBackendMode("community", async () => {
      const meta = metaOf("task-fail-1", "/workspace/fail");
      await harness.repo.syncTaskMeta({ meta });
      await assert.rejects(
        (harness.service as IZCodeTaskService).deleteTask(meta),
        (error) => /桥接|运行中/.test(String((error as Error).message)) || (error as { code?: number }).code === -32000,
      );
      assert.equal(
        harness.repoCalls.some((c) => c.name === "updateTaskState"),
        false,
        "v4 失败时 task-index 不得写墓碑",
      );
    });
  } finally {
    await harness.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("v4 回 -32002（桥接无本地记录）：幂等视为已删、墓碑照落", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-v4-del-notfound-"));
  const harness = await createHarness({
    repoPath: join(dir, "tasks.sqlite"),
    v4Response: async () => {
      throw Object.assign(new Error("找不到该会话的本地记录"), { code: -32002 });
    },
  });
  try {
    await withBackendMode("community", async () => {
      const meta = metaOf("task-notfound-1", "/workspace/notfound");
      await harness.repo.syncTaskMeta({ meta });
      await (harness.service as IZCodeTaskService).deleteTask(meta);
      assert.equal(harness.v4Calls.length, 1, "幂等路径也应先尝试 v4（才会拿到 -32002）");
      assert.ok(
        harness.repoCalls.some((c) => c.name === "updateTaskState"),
        "-32002 幂等路径必须照常落 task-index 墓碑",
      );
    });
  } finally {
    await harness.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteArchivedTasks 批量：逐条 v4 失败只该条 failed、其它条照常删除", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-v4-del-batch-"));
  const failing = new Set(["task-batch-fail-1", "task-batch-fail-2"]);
  const harness = await createHarness({
    repoPath: join(dir, "tasks.sqlite"),
    v4Response: async (envelope) => {
      if (failing.has(String(envelope.sessionId))) {
        throw Object.assign(new Error("归档会话数据失败"), { code: -32000 });
      }
      return { commandId: "ack", status: "accepted", revisionAtDecision: 1 } satisfies CommandAck;
    },
  });
  try {
    await withBackendMode("community", async () => {
      const metas = [
        metaOf("task-batch-fail-1", "/workspace/batch"),
        metaOf("task-batch-fail-2", "/workspace/batch"),
        metaOf("task-batch-ok-1", "/workspace/batch"),
      ];
      for (const meta of metas) {
        await harness.repo.syncTaskMeta({ meta });
        // 归档区删除的前提是行已 archived（deleteArchivedTask 只处理归档行）。
        await harness.repo.updateTaskState({
          workspacePath: meta.workspacePath,
          workspaceIdentity: meta.workspaceIdentity,
          taskId: meta.taskId,
          patch: { archived: true },
        });
      }
      harness.repoCalls.length = 0; // 清掉 seed 期的记录，只断言批次执行期。
      const result = await (harness.service as IZCodeTaskService).deleteArchivedTasks({
        taskIds: metas.map((m) => m.taskId),
        workspacePath: "/workspace/batch",
        workspaceIdentity: undefined,
      });
      assert.deepEqual([...result.failedTaskIds].sort(), ["task-batch-fail-1", "task-batch-fail-2"]);
      assert.deepEqual([...result.deletedTaskIds], ["task-batch-ok-1"]);
      const v4Ids = harness.v4Calls.map((call) => call.envelope.sessionId).sort();
      assert.deepEqual(v4Ids, metas.map((m) => m.taskId).sort(), "批次内每条都应尝试 v4（失败项也发过）");
      assert.equal(
        harness.repoCalls.filter((c) => c.name === "deleteArchivedTask").length,
        1,
        "只有 v4 成功的那条才落 repo.deleteArchivedTask（失败项不落）",
      );
    });
  } finally {
    await harness.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
