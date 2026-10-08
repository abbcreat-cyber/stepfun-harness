import type { StepMiniTask } from "@zcode/shared";
import type { ConversationStoreState } from "./conversationProjectionStore.js";

type Source = {
  getState(): Pick<ConversationStoreState, "status" | "snapshot">;
  subscribe(listener: () => void): () => void;
};
type Scope = { workspacePath: string; workspaceIdentity?: string };

/** 仅持有现有会话投影的轻量呈现，不拥有执行状态、不新建订阅链路。 */
export function createStepMiniLiveActivity() {
  const entries = new Map<object, StepMiniTask | null>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    attach(scope: Scope, sessionId: string, source: Source) {
      const owner = {};
      let signature = "";
      const refresh = () => {
        const { status, snapshot } = source.getState();
        let task: StepMiniTask | null = null;
        if (status !== "closed" && snapshot) {
          const header = snapshot.rows.window.findLast((row) => row.kind === "turnHeader");
          const firstInput = snapshot.rows.window.find((row) => row.kind === "userInput");
          const phase = snapshot.control.phase;
          const state: StepMiniTask["state"] = snapshot.pendingInteractions.length
            ? "attention"
            : phase === "running" || phase === "prewarming" || snapshot.backgroundWorks.some((work) => work.status === "running")
              ? "running"
              : phase === "error" ? "failed" : phase === "draft" ? "idle" : "completed";
          task = {
            key: `${scope.workspaceIdentity?.trim() || scope.workspacePath}\0${sessionId}`,
            taskId: sessionId,
            ...scope,
            title: (snapshot.meta?.title || firstInput?.text || "").slice(0, 200),
            state,
            updatedAt: header?.endedAt ?? header?.startedAt ?? 0,
          };
        }
        const next = JSON.stringify(task);
        if (next === signature) return;
        signature = next;
        entries.set(owner, task);
        notify();
      };
      entries.set(owner, null);
      const unsubscribe = source.subscribe(refresh);
      refresh();
      return () => { unsubscribe(); entries.delete(owner); notify(); };
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getTasks() { return [...entries.values()].filter((task): task is StepMiniTask => task !== null); },
  };
}

/** 实时会话状态覆盖同任务的滞后索引，包括终态；合并后再过滤，防止结束任务复活。 */
export function mergeStepMiniActivity(indexed: readonly StepMiniTask[], live: readonly StepMiniTask[]) {
  const tasks = new Map(indexed.map((task) => [task.key, task]));
  for (const task of live) tasks.set(task.key, { ...task, title: tasks.get(task.key)?.title || task.title });
  return [...tasks.values()];
}

export const stepMiniLiveActivity = createStepMiniLiveActivity();
