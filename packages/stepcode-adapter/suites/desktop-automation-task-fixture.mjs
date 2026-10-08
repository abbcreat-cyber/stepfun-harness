/** 公共 task adapter 使用真实 Host/SQLite；仅 UI/index 订阅设施替为隔离 emitter。 */
export async function createFixtureTaskAdapter(agent) {
  const { createZCodeTaskServiceAdapter } = await import("../../services/src/node.ts");
  const { Emitter } = await import("../../rpc/src/index.ts");
  const workspaceEvents = new Emitter(),
    terminalEvents = new Emitter(),
    readyEvents = new Emitter();
  return createZCodeTaskServiceAdapter({
    zcodeAgentService: agent,
    taskIndexSyncer: {
      ensureSessionSubscription() {},
      getWorkspaceEmitter: () => workspaceEvents,
      emitWorkspaceTaskListChanged() {},
      onDynamicWorkspaceEvent: () => workspaceEvents.event,
      onSessionTerminalEvent: terminalEvents.event,
      onSessionReadyEvent: readyEvents.event,
      disposeAll() {
        workspaceEvents.dispose();
        terminalEvents.dispose();
        readyEvents.dispose();
      },
    },
  });
}
