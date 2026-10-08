import type { StepMiniTask } from "./step-mini.js";

export const STEP_MINI_SCALE = 0.8;

/** 总数独立于展示上限；相同任务被多个窗口订阅时只计一次。 */
export function countStepMiniActiveTasks(feeds: readonly {
  tasks: readonly StepMiniTask[];
  activeTaskKeys?: readonly string[];
}[]): number {
  return new Set(feeds.flatMap((feed) =>
    feed.activeTaskKeys ?? selectStepMiniActiveTasks(feed.tasks, feed.tasks.length).map((task) => task.key),
  )).size;
}

/** 原生容器围绕控制条扩大；屏幕边缘只限制列表，不移动控制条锚点。 */
export function stepMiniWindowLayout(
  anchor: { right: number; bottom: number },
  expanded: boolean,
  taskCount: number,
  work: { x: number; y: number; width: number; height: number },
) {
  const compact = stepMiniWindowSize(false, 0, work.height);
  const desired = stepMiniWindowSize(expanded, taskCount, work.height);
  const above = anchor.bottom - work.y;
  const below = work.y + work.height - (anchor.bottom - compact.height);
  const direction = desired.height > above && below > above ? "down" : "up";
  const width = Math.max(compact.width, Math.min(desired.width, anchor.right - work.x));
  const height = Math.max(compact.height, Math.min(desired.height, direction === "up" ? above : below));
  return {
    direction,
    bounds: {
      x: anchor.right - width,
      y: direction === "up" ? anchor.bottom - height : anchor.bottom - compact.height,
      width,
      height,
    },
  };
}

/** Mini 是活跃任务提示，不是历史列表；过滤必须在截断之前，结束即移除。 */
export function selectStepMiniActiveTasks(
  tasks: readonly StepMiniTask[],
  limit = 12,
): StepMiniTask[] {
  const rank = { attention: 0, running: 1 };
  return tasks
    .filter(
      (task): task is StepMiniTask & { state: "attention" | "running" } =>
        task.state === "running" || task.state === "attention",
    )
    .sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function stepMiniWindowSize(expanded: boolean, taskCount: number, workHeight: number) {
  const hasCards = expanded && taskCount > 0;
  return {
    width: Math.round((hasCards ? 400 : 260) * STEP_MINI_SCALE),
    height: hasCards
      ? Math.min(workHeight - 20, Math.round((86 + taskCount * 72) * STEP_MINI_SCALE))
      : Math.round(72 * STEP_MINI_SCALE),
  };
}
