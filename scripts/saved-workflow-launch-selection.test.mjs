import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSavedWorkflowLaunchSelection } from "../packages/ui/src/settings/saved-workflows/savedWorkflowLaunchSelection.ts";

const choice = { providerId: "custom-subscription", modelId: "my-model", options: { reasoningLevel: "disabled" } };
function view(selection = choice) {
  return { revision: 1, preferredSelection: choice, effectiveSelection: selection,
    providers: [{ providerId: choice.providerId, models: [{ modelId: choice.modelId,
      config: { optionSpecs: { reasoningLevel: { values: ["enabled", "disabled"] } } } }] }] };
}
test("模板启动读取目标目录默认模型，不回退硬编码 Step", async () => {
  const calls = [];
  const selected = await resolveSavedWorkflowLaunchSelection({ getView: async input => { calls.push(input); return view(); } });
  assert.deepEqual(selected, choice); assert.deepEqual(calls, [undefined, { selection: choice }]);
  assert.notEqual(selected, choice);
});
test("目标工作区最近已接受模型保留推理档位，并由目标 Host 再确认", async () => {
  const recent = { ...choice, options: { reasoningLevel: "enabled" } }, calls = [];
  const selected = await resolveSavedWorkflowLaunchSelection({ getView: async input => { calls.push(input); return view(recent); } }, recent);
  assert.deepEqual(calls, [{ selection: recent }]); assert.deepEqual(selected, recent);
});
test("明确选型被删除时拒绝，不偷偷使用另一首选模型", async () => {
  await assert.rejects(resolveSavedWorkflowLaunchSelection({ getView: async () => view(null) }, choice), /unavailable/);
  await assert.rejects(resolveSavedWorkflowLaunchSelection({ getView: async () => ({ revision: 1, providers: [] }) }), /configure/);
});
test("不支持的档位与目录读取错误均阻止启动", async () => {
  const invalid = { ...choice, options: { reasoningLevel: "unsupported" } };
  await assert.rejects(resolveSavedWorkflowLaunchSelection({ getView: async () => view(invalid) }, invalid), /unavailable/);
  await assert.rejects(resolveSavedWorkflowLaunchSelection({ getView: async () => { throw new Error("registry unavailable"); } }), /registry unavailable/);
});
