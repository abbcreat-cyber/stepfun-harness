import assert from "node:assert/strict";
import test from "node:test";
import { getExecuteGroupActivity } from "../src/lib/executeGroupActivity.js";

const running = { toolCall: { status: "in_progress", raw: { v4Status: "running" } } };
const waiting = { toolCall: { status: "pending", raw: { v4Status: "pendingApproval" } } };
const preparing = { toolCall: { status: "pending", raw: { v4Status: "inputStreaming" } } };
test("命令组优先实际运行项，不让最后的审批或准备项冒充执行", () => {
  assert.deepEqual(getExecuteGroupActivity([running, waiting, preparing], true), {
    phase: "running",
    child: running,
  });
  assert.deepEqual(getExecuteGroupActivity([waiting, preparing], true), {
    phase: "awaitingApproval",
    child: waiting,
  });
  assert.deepEqual(getExecuteGroupActivity([preparing], true), {
    phase: "pending",
    child: preparing,
  });
});
test("停止后以及全部终态立即显示完成统计，不继续播放旧命令", () => {
  assert.deepEqual(getExecuteGroupActivity([running, waiting], false), { phase: "complete" });
  for (const status of ["completed", "failed", "stopped"])
    assert.deepEqual(
      getExecuteGroupActivity(
        [{ toolCall: { status, raw: { v4Status: "pendingApproval" } } }],
        true,
      ),
      { phase: "complete" },
    );
  assert.deepEqual(getExecuteGroupActivity([], true), { phase: "complete" });
});
test("兼容旧 pending，并选择最后一条真实运行的命令", () => {
  const another = { toolCall: { status: "in_progress" } };
  assert.deepEqual(
    getExecuteGroupActivity([{ toolCall: { status: "pending" } }], true).phase,
    "pending",
  );
  assert.equal(getExecuteGroupActivity([running, another, waiting], true).child, another);
});
