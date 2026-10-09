import {
  reduceWorkflowRunsState,
  savedWorkflows,
  artifactsOf,
  listArtifactItemsFrom,
  readWorkflowArtifactBytes,
  listWorkspaceNodesFrom,
  readWorkspaceNodeResultFrom,
} from "./dependencies.mjs";

/** 所有查询只从当前会话 journal 与产物库派生；写入仍由 StepWorkflowService 持有。 */
export class WorkflowReadModel {
  refresh() {
    for (const record of this.journal
      .listRunsByParentSession(this.options.sessionId, 8)
      .reverse()) {
      const prior = this.state.runs.find((run) => run.runId === record.runId);
      for (const item of this.journal.listEvents(
        record.runId,
        prior ? { afterSequence: prior.lastEventSequence } : undefined,
      )) {
        // actor-created 是声明；实际会话只在 driver 就绪后存在，不能让界面一直显示未启动。
        const actorRef = item.event.actor;
        const actorSessionId = actorRef
          ? this.journal.getActor(record.runId, actorRef.siteId, actorRef.ordinal)?.sessionId
          : undefined;
        this.state =
          reduceWorkflowRunsState(this.state, {
            runId: record.runId,
            toolCallId: record.toolCallId,
            sequence: item.sequence,
            eventType: item.event.type,
            payload: item.event,
            ...(actorSessionId ? { actorSessionId } : {}),
          }) ?? this.state;
      }
      const full = this.journal.getRun(record.runId);
      const projected = this.state.runs.find((value) => value.runId === record.runId);
      if (projected) {
        projected.concurrencyCeiling = 8;
        // 原 bootstrap 会把 launch 元数据并入 run-started；直接调用引擎时需从同一 journal 补齐。
        const launch = projected.subagentModel ? undefined
          : this.journal.listEvents(record.runId).find(item => item.event.type === "run-launched")?.event;
        if (launch?.subagentModel) projected.subagentModel = launch.subagentModel;
        if (full?.resumedFrom) projected.resumedFrom = full.resumedFrom;
        const limit = full?.caps?.maxConcurrency;
        if (Number.isInteger(limit) && limit < 8) projected.concurrency = { cap: 8, ceiling: 8, limit };
        else delete projected.concurrency;
        if (full?.stopReason) projected.stopReason = full.stopReason;
        // 通用 reducer 保留已声明 actor 条目；Step 延迟建会话，派发后用账本补齐真实 ID。
        projected.actors = projected.actors.map((actor) => {
          const id = this.journal.getActor(record.runId, actor.siteId, actor.ordinal)?.sessionId;
          return id && actor.sessionId !== id ? { ...actor, sessionId: id } : actor;
        });
        if (full?.status === "stopped") projected.resumable = true;
        else delete projected.resumable;
      }
      if (full?.status === "completed") {
        const run = this.state.runs.find((value) => value.runId === record.runId);
        if (run) run.resultPreview = JSON.stringify(full.result ?? null).slice(0, 2000);
      }
    }
    for (const run of this.state.runs) {
      const successor = this.state.runs.find(item => item.resumedFrom === run.runId);
      if (successor) run.supersededBy = successor.runId;
    }
    return this.state;
  }

  assertRun(runId) {
    const record = this.journal.getRun(runId);
    if (!record || record.parentSessionId !== this.options.sessionId)
      throw new Error("工作流不存在或不属于当前会话");
    return record;
  }

  list() {
    return this.journal.listRunsByParentSession(this.options.sessionId, 64).map((item) => ({
      runId: item.runId,
      ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
      label: item.name || "Step Code 工作流",
      status: item.status,
      resumable: item.status === "stopped",
      ...(item.timeUpdated ? { updatedAt: item.timeUpdated } : {}),
    }));
  }
  detail(runId) {
    return {
      run: this.assertRun(runId),
      actors: this.journal.listActors(runId),
      nodes: this.journal.listNodes(runId),
      pendingQuestions: this.questions?.list(runId) ?? [],
    };
  }
  events(runId, afterSequence, limit = 100) {
    this.assertRun(runId);
    const events = this.journal.listEvents(runId, { afterSequence, limit: limit + 1 });
    return {
      events: events
        .slice(0, limit)
        .map((item) => ({ sequence: item.sequence, type: item.event.type, payload: item.event })),
      hasMore: events.length > limit,
    };
  }
  async workspace(runId) {
    this.assertRun(runId);
    const nodes = await listWorkspaceNodesFrom(
      { journal: this.journal, parentSessionId: this.options.sessionId },
      runId,
    );
    return {
      nodes: (nodes ?? []).slice(0, 256),
      ...((nodes?.length ?? 0) > 256 ? { truncated: true } : {}),
    };
  }
  async nodeResult(params) {
    this.assertRun(params.runId);
    const result = await readWorkspaceNodeResultFrom(
      { journal: this.journal, parentSessionId: this.options.sessionId },
      params.runId,
      params.siteId,
      params.ordinal,
      { maxBytes: Math.min(params.maxBytes ?? 32768, 32768) },
    );
    if (!result) throw new Error("找不到工作流节点");
    return result;
  }
  artifacts(runId) {
    this.assertRun(runId);
    return { artifacts: artifactsOf(runId, this.journal).artifacts ?? [] };
  }
  artifactData(params) {
    this.assertRun(params.runId);
    const limit = Math.max(1, Math.min(500, params.limit ?? 200));
    const items = listArtifactItemsFrom(this.journal, params.runId, params.artifactId, {
      afterSequence: params.afterSequence,
      limit: limit + 1,
    });
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }
  async artifactRead(params) {
    this.assertRun(params.runId);
    if (
      !Number.isInteger(params.offset) ||
      params.offset < 0 ||
      !Number.isInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > 524288
    )
      throw new Error("产物读取范围无效");
    const result = await readWorkflowArtifactBytes(
      {
        journal: this.journal,
        parentSessionId: this.options.sessionId,
        artifactStore: this.artifactStore,
      },
      params.runId,
      params.artifactId,
      params.version,
    );
    if (!result) throw new Error("找不到工作流产物版本");
    const bytes = Buffer.from(result.bytes),
      end = Math.min(bytes.length, params.offset + params.limit);
    return {
      dataBase64: bytes.subarray(params.offset, end).toString("base64"),
      mediaType: result.contentType || "application/octet-stream",
      totalBytes: bytes.length,
      nextOffset: end < bytes.length ? end : null,
    };
  }
  listSaved(params = {}) {
    const options = {
      cwd: this.options.cwd,
      scope: params.scope ?? "project",
      homeDir: this.options.homeRoot ?? this.options.root,
    };
    const result = savedWorkflows.listSavedWorkflows(options);
    return {
      workflows: result.entries,
      invalid: result.invalid,
      dir: savedWorkflows.savedWorkflowRoot(options.cwd, options.scope, {
        homeDir: options.homeDir,
      }).dir,
    };
  }
  getSaved(params) {
    return savedWorkflows.resolveSavedWorkflow({
      cwd: this.options.cwd,
      name: params.name,
      scope: params.scope,
      homeDir: this.options.homeRoot ?? this.options.root,
    });
  }
}
