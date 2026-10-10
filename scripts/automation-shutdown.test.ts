import { test } from "node:test";
import assert from "node:assert/strict";
import { settleCronRunOnShutdown } from "../packages/desktop/src/host/cronRunLifecycle.js";

test("正常退出释放本 Host 手动运行，关闭失败或远端运行保留租约", async () => {
  for (const [local, servicesClosed, expected] of [[true, true, true], [false, true, false], [true, false, false]]) {
    const calls: string[] = [];
    await settleCronRunOnShutdown({ runId: "owned-run", automationId: "owned-task", workspaceKey: "workspace", trigger: "manual", scheduledAt: null,
      local: local!, servicesClosed: servicesClosed!, logWarn: () => {},
      repo: {
        ensureRunClaimed: async () => { calls.push("ensure-owned"); },
        markRunOutcome: async (id, outcome) => { assert.equal(id, "owned-run"); assert.equal(outcome, "stopped"); calls.push("stopped"); },
        markRunDispatch: async () => {}, touchManualClaim: async () => {},
        releaseManualClaim: async (id, workspace) => { assert.equal(id, "owned-task"); assert.equal(workspace, "workspace"); calls.push("released"); },
      },
    });
    assert.deepEqual(calls, expected ? ["ensure-owned", "stopped", "released"] : []);
  }
});
