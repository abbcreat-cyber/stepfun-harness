import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StepWorkflowService } from "../src/workflow/service.mjs";
import { readWorkflowGuide } from "../src/workflow/guide.mjs";
import { createStepActorActivity } from "../src/workflow/step-activity.mjs";

async function execute(script, cap) {
  const root = await mkdtemp(join(tmpdir(), "step-activity-"));
  const states = [];
  const service = new StepWorkflowService({
    communicationMode: "mock",
    root,
    cwd: root,
    sessionId: "activity",
    model: { providerId: "step", modelId: "step-5-preview" },
    command: [
      process.execPath,
      fileURLToPath(new URL("../mock/step-rpc-mock.mjs", import.meta.url)),
      "--delay",
      "30",
    ],
    confirm: async () => ({ approved: true }),
    onState: (state) => states.push(structuredClone(state)),
  });
  try {
    await service.guide();
    const created = await service.create({ script, max_concurrency: cap }, "activity-call");
    await service.active.get(created.runId)?.promise;
    assert.equal(service.detail(created.runId).run.status, "completed");
    return {
      states,
      events: service.journal.listEvents(created.runId).map((value) => value.event),
    };
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}
const agents = 'phase("检查");const a=agent("A");const b=agent("B");const c=agent("C");';
test("parallel actors report executing, respect the original cap, and finish at zero working", async () => {
  const { states, events } = await execute(
    agents + 'return await Promise.all([a.ask("alpha"),b.ask("beta"),c.ask("gamma")]);',
    2,
  );
  const counts = states.map(
    (state) => state.runs[0].actors.filter((actor) => actor.status === "running").length,
  );
  assert.equal(Math.max(...counts), 2, "运行中不能始终显示零，也不能把上限外的等待者算作执行者");
  assert.equal(counts.at(-1), 0);
  assert.equal(events.filter((event) => event.type === "node-executing").length, 3);
});
test("sequential awaits stay sequential in the unchanged ZCode engine", async () => {
  const { states, events } = await execute(
    agents +
      'const x=await a.ask("alpha");const y=await b.ask("beta");const z=await c.ask("gamma");return [x,y,z];',
    4,
  );
  assert.equal(
    Math.max(
      ...states.map(
        (state) => state.runs[0].actors.filter((actor) => actor.status === "running").length,
      ),
    ),
    1,
  );
  const firstDone = events.findIndex(
    (event) => event.type === "node-settled" && event.instance.siteId === "ask#1",
  );
  const secondStart = events.findIndex(
    (event) => event.type === "node-dispatched" && event.instance.siteId === "ask#2",
  );
  assert.ok(firstDone < secondStart, "不能按名册的竖排擅自改变已确认脚本的顺序");
});
test("default guide preserves the complete original ZCode authoring contract", async () => {
  const original = await readFile(
    new URL(
      "../../../apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok((await readWorkflowGuide()).content === original, "默认指南必须逐字保留原版全文");
  assert.match((await readWorkflowGuide("patterns")).content, /Parallelism comes from/);
});
test("Step retries enter the original waiting state and the next real turn resumes executing", () => {
  const reports = [],
    instance = { siteId: "ask#1", ordinal: 1 };
  let live = true;
  const observe = createStepActorActivity(
    {
      askExecuting: (ref) => reports.push({ type: "executing", ref }),
      askWaiting: (ref, info) => reports.push({ type: "waiting", ref, info }),
    },
    instance,
    () => live,
  );
  observe({ type: "turn_start" });
  observe({ type: "message_start", message: { role: "assistant" } });
  assert.equal(reports.length, 1, "一个实际回合的重复观察不能重复报执行");
  observe({
    type: "auto_retry_start",
    attempt: 2,
    delayMs: 300,
    errorMessage: "HTTP 429 rate limited",
  });
  assert.deepEqual(reports.at(-1).info, {
    cause: "backoff",
    reason: "rate_limited",
    attempt: 2,
    delayMs: 300,
  });
  observe({ type: "turn_start" });
  assert.equal(reports.at(-1).type, "executing");
  live = false;
  observe({ type: "auto_retry_start", attempt: 3, delayMs: 500, errorMessage: "retry" });
  observe({ type: "turn_start" });
  assert.equal(reports.length, 3, "取消或完成后的迟到事件不得恢复工作中状态");
});
