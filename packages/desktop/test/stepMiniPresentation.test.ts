import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectStepMiniActiveTasks,
  stepMiniWindowSize,
  stepMiniWindowLayout,
  countStepMiniActiveTasks,
} from "../../shared/src/step-mini-presentation.ts";
import type { StepMiniTask } from "../../shared/src/step-mini.ts";
const task = (state: StepMiniTask["state"], updatedAt: number): StepMiniTask => ({
  key: state,
  taskId: state,
  workspacePath: "D:/test",
  title: state,
  state,
  updatedAt,
});

test("active Mini excludes recent terminal tasks before limiting and removes completed work", () => {
  const running = task("running", 1),
    waiting = task("attention", 2);
  assert.deepEqual(
    selectStepMiniActiveTasks(
      [task("completed", 99), task("failed", 98), task("idle", 97), running, waiting],
      2,
    ).map((t) => t.state),
    ["attention", "running"],
  );
  assert.deepEqual(selectStepMiniActiveTasks([{ ...running, state: "completed" }]), []);
});
test("Mini viewport matches uniform 80 percent scale, including empty expanded state", () => {
  assert.deepEqual(stepMiniWindowSize(false, 0, 900), { width: 208, height: 58 });
  assert.deepEqual(stepMiniWindowSize(true, 1, 900), { width: 320, height: 126 });
  assert.deepEqual(stepMiniWindowSize(true, 0, 900), { width: 208, height: 58 });
});

test("active count includes off-card tasks and deduplicates windows", () => {
  const keys = Array.from({ length: 20 }, (_, i) => `task-${i}`);
  assert.equal(countStepMiniActiveTasks([
    { tasks: [task("running", 1)], activeTaskKeys: keys },
    { tasks: [], activeTaskKeys: keys.slice(0, 3) },
  ]), 20);
  assert.equal(countStepMiniActiveTasks([
    { tasks: [task("completed", 2), task("running", 1)] },
    { tasks: [task("running", 1), task("attention", 3)] },
  ]), 2);
});

test("expand keeps toolbar anchored at bottom, top and left screen edges", () => {
  const work = { x: -1200, y: -50, width: 1200, height: 900 };
  for (const anchor of [{ right: -400, bottom: 800 }, { right: -400, bottom: 20 }, { right: -970, bottom: 800 }]) {
    for (const count of [1, 3, 6]) {
      const layout = stepMiniWindowLayout(anchor, true, count, work);
      assert.equal(layout.bounds.x + layout.bounds.width, anchor.right);
      assert.equal(layout.bounds.y + (layout.direction === "up" ? layout.bounds.height : 58), anchor.bottom);
      assert.ok(layout.bounds.x >= work.x);
      assert.ok(layout.bounds.y >= work.y);
      assert.ok(layout.bounds.y + layout.bounds.height <= work.y + work.height);
    }
  }
  assert.equal(stepMiniWindowLayout({ right: -400, bottom: 20 }, true, 2, work).direction, "down");
});
