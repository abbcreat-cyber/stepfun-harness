import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnboundedContextRuleGoal } from "../src/desktop-task-contracts.mjs";

test("context rule cannot become a never-completing goal, finite work remains allowed", () => {
  assert.equal(
    isUnboundedContextRuleGoal("每轮对话从第一性原理出发，这是长期行为约束，不要标记完成"),
    true,
  );
  for (const objective of [
    "实现第一性原理钩子并在两轮验证后完成",
    "修复接口并完成测试",
    "每日报告数据趋势直到项目完成",
  ])
    assert.equal(isUnboundedContextRuleGoal(objective), false);
});
