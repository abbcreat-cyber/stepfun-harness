import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { makeConversationSnapshot, makeTurnHeaderRow } from "../../stepcode-adapter/src/wire-shapes.mjs";
import { createStepMiniLiveActivity, mergeStepMiniActivity } from "../../ui/src/v4/stepMiniLiveActivity.ts";
import { selectStepMiniActiveTasks } from "../../shared/src/step-mini-presentation.ts";

function source(sessionId: string) {
  const listeners = new Set<() => void>();
  let snapshot = conversationSnapshotSchema.parse(makeConversationSnapshot({ sessionId, logEpoch: "e", seq: 1, revision: 1, phase: "running", rows: [makeTurnHeaderRow({rowId:1,turnId:"t",state:"running"})] }));
  return {
    getState: () => ({ status: "live" as const, snapshot }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    finish: () => { snapshot = { ...snapshot, control: { ...snapshot.control, phase: "completedSuccess", canStop: false, sessionEnded: true } }; listeners.forEach(listener => listener()); },
  };
}

test("Mini: live conversation stays visible when list index still says completed", () => {
  const registry = createStepMiniLiveActivity(), live = source("task");
  const detach = registry.attach({workspacePath:"D:/work"}, "task", live);
  const [running] = registry.getTasks();
  const stale = [{...running, state: "completed" as const}];
  assert.equal(selectStepMiniActiveTasks(stale).length, 0, "old index-only path reproduces missing task");
  assert.equal(selectStepMiniActiveTasks(mergeStepMiniActivity(stale, registry.getTasks())).length, 1);
  let notifications = 0; registry.subscribe(() => notifications++);
  live.finish();
  assert.equal(notifications, 1, "phase change publishes synchronously without React render or animation frame");
  assert.equal(selectStepMiniActiveTasks(mergeStepMiniActivity([running], registry.getTasks())).length, 0, "terminal live state overrides stale running index");
  detach();assert.equal(registry.getTasks().length, 0);
});

test("Mini: duplicate views count once and workspace identities remain separate", () => {
  const registry = createStepMiniLiveActivity();
  const offOld = registry.attach({workspacePath:"/work",workspaceIdentity:"host-a"},"task",source("task"));
  const offNew = registry.attach({workspacePath:"/work",workspaceIdentity:"host-a"},"task",source("task"));
  const offOther = registry.attach({workspacePath:"/work",workspaceIdentity:"host-b"},"task",source("task"));
  assert.equal(mergeStepMiniActivity([],registry.getTasks()).length,2);
  offOld();assert.equal(mergeStepMiniActivity([],registry.getTasks()).length,2);
  offNew();offOther();assert.equal(registry.getTasks().length,0);
});
