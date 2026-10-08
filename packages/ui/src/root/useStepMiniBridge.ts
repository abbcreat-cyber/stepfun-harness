import { useEffect, useMemo, useRef } from "react";
import type { IPlatformService, StepMiniSnapshot, StepMiniTask } from "@zcode/shared";
import { createUuid, selectStepMiniActiveTasks } from "@zcode/shared";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { isWorkspaceTab, type WindowTabState } from "@/store/tabStore.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { getTaskListAttention, isTaskListRowActive } from "@/v4/taskListRowActivity.js";
import { stepMiniLiveActivity, mergeStepMiniActivity } from "@/v4/stepMiniLiveActivity.js";
import { logger } from "@/logger.js";

export function useStepMiniBridge(input: {
  platform: IPlatformService;
  locale: string;
  tabs: WindowTabState[];
  activateTabByPath: (path: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (path: string, options?: { workspaceIdentity?: string }) => void;
  startNewTask: (source: string) => void;
}) {
  const revision = useRef(0);
  const generation = useRef(createUuid());
  const workspaceTabs = useMemo(
    () => (input.platform.publishStepMini ? input.tabs.filter(isWorkspaceTab) : []),
    [input.tabs, input.platform],
  );
  // 复用侧栏同一个 Controller 的任务/会话投影；旧兼容 store 的 taskListCache 在 v4 下不再写入。
  const list = useGlobalTaskList({
    kind: "active",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 12,
  });
  useEffect(() => {
    if (!input.platform.publishStepMini) return;
    const publish = () => {
      const tasks: StepMiniTask[] = list.items.map((task) => {
        const attention = getTaskListAttention(task) || task.liveStatus === "waiting";
        const running = isTaskListRowActive(task) || task.liveStatus === "running";
        const state = attention
          ? "attention"
          : running
            ? "running"
            : task.liveStatus === "error"
              ? "failed"
              : task.liveStatus === "completed"
                ? "completed"
                : "idle";
        return {
          key: `${task.workspaceIdentity || task.workspacePath}\0${task.taskId}`,
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          title: task.title.slice(0, 200),
          state,
          updatedAt: task.updatedAt,
        };
      });
      const scopes = new Set(workspaceTabs.map((tab) => tab.workspaceIdentity?.trim() || tab.workspacePath));
      const liveTasks = stepMiniLiveActivity.getTasks().filter((task) => scopes.has(task.workspaceIdentity?.trim() || task.workspacePath));
      const merged = mergeStepMiniActivity(tasks, liveTasks);
      const activeTasks = selectStepMiniActiveTasks(merged, merged.length);
      const snapshot: StepMiniSnapshot = {
        generation: generation.current,
        revision: ++revision.current,
        fontSize: Math.min(
          32,
          Math.max(
            10,
            parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size"),
            ) || 14,
          ),
        ),
        dark: document.documentElement.classList.contains("dark"),
        locale: input.locale,
        tasks: activeTasks.slice(0, 12),
        activeTaskKeys: activeTasks.map((task) => task.key),
      };
      void input.platform.publishStepMini!(snapshot).catch((error) => logger.warn("[StepMini] 状态推送失败", error));
    };
    const observer = new MutationObserver(publish);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    publish();
    const unsubscribe = stepMiniLiveActivity.subscribe(publish);
    return () => { observer.disconnect(); unsubscribe(); };
  }, [input.platform, input.locale, list.items, workspaceTabs]);
  useEffect(
    () =>
      input.platform.onStepMiniAction?.((action) => {
        if (action.type === "new-task") {
          input.startNewTask("step-mini");
          return;
        }
        const task = action.task,
          options = task.workspaceIdentity
            ? { workspaceIdentity: task.workspaceIdentity }
            : undefined;
        if (!input.activateTabByPath(task.workspacePath, options)) {
          // 未连接远端不能把相同路径当作本地项目打开。
          if (task.workspaceIdentity) return;
          input.addTab(task.workspacePath, options);
        }
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(task.workspacePath, task.taskId, task.workspaceIdentity);
      }),
    [input.platform, input.activateTabByPath, input.addTab, input.startNewTask],
  );
}
