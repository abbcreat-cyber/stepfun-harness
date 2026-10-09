import { WorkflowReadModel } from "./read-model.mjs";
import { WorkflowOwnership } from "./ownership.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { readWorkflowGuide } from "./guide.mjs";
import {
  engine,
  runWorkflowScript,
  createSqliteSessionStore,
  boundCausalityGraph,
  createNodeFileSystemAdapter,
  createNodeExecutionAdapter,
  NodeToolArtifactStore,
  savedWorkflows,
  buildImportedCache,
  formatModelPickerValue,
} from "./dependencies.mjs";
import { createStepWorkflowDriver } from "./step-driver.mjs";
import { readDesktopCredentialEnv } from "../credentials.mjs";
import { hydrateActorTranscripts } from "./actor-transcript.mjs";
import { evalSnippet, amend } from "./operations.mjs";
import { WorkflowQuestions } from "./questions.mjs";
import { resolveWorkflowModel, persistedWorkflowModel } from "./model-selection.mjs";

export class StepWorkflowService extends WorkflowReadModel {
  constructor(options) {
    super();
    this.options = options;
    this.active = new Map();
    this.snippets = new Set();
    this.amending = new Set();
    this.questions = new WorkflowQuestions(this);
    this.ownership = new WorkflowOwnership(join(options.root, "workflow-owners.sqlite"));
    this.store = createSqliteSessionStore({ dbPath: join(options.root, "workflow-runs.sqlite") });
    this.journal = this.store.workflowJournalStore();
    this.state = { revision: 0, runs: [] };
    this.guideRead = false;
    this.artifactStore = new NodeToolArtifactStore({
      rootDir: join(options.root, "artifacts"),
      imageCacheRootDir: join(options.root, "images"),
    });
    this.refresh();
  }

  async guide(which = "skill") {
    const guide = await readWorkflowGuide(which);
    this.guideRead = true;
    return guide;
  }
  evalSnippet(input, toolCallId) { return evalSnippet.call(this, input, toolCallId); }
  amend(input, toolCallId, origin, control) { return amend.call(this, input, toolCallId, origin, control); }
  resolveQuestion(input) { return this.questions.resolve(input.question_id, input.answer); }

  async prepare(input) {
    const selectedModel = await resolveWorkflowModel(this, input.subagent_model);
    let script = input.script;
    if (input.path !== undefined) input = { ...input, script_path: input.path };
    if (script !== undefined && input.script_path !== undefined) throw new Error("script 和 path 不能同时提供");
    if (input.saved?.name) {
      const saved = this.getSaved({ name: input.saved.name, scope: input.saved.scope });
      if (!saved.ok) throw new Error(`无法加载工作流：${saved.reason}`);
      script = saved.script;
    }
    if (!script && input.script_path) {
      const path = await realpath(resolve(this.options.cwd, input.script_path));
      const root = await realpath(this.options.cwd);
      const rel = relative(root, path);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("脚本路径必须在当前工作区内");
      script = await readFile(path, "utf8");
    }
    if (typeof script !== "string" || !script.trim() || Buffer.byteLength(script) > 262144)
      throw new Error("请提供不超过 256KB 的工作流脚本");
    const analysis = engine.analyzeWorkflowScript(script);
    const graph = analysis.causality
      ? boundCausalityGraph(analysis.causality, analysis.flow, analysis.handoff)
      : undefined;
    const display = {
      kind: "create_workflow",
      ok: analysis.ok,
      errorCount: analysis.diagnostics.length,
      diagnostics: analysis.diagnostics.slice(0, 100).map((d) => ({
        line: d.line ?? 0,
        column: d.column ?? 0,
        code: d.code ?? 0,
        message: d.message.slice(0, 2000),
      })),
      ...(graph ? { causalityGraph: graph } : {}),
    };
    if (!analysis.ok) return { ok: false, display, diagnostics: analysis.diagnostics };
    const program = engine.createWorkflowProgram(script),
      table = engine.collectSites(program);
    const schemas = engine.synthesizeAskSchemas(program, table);
    if (schemas.diagnostics.length)
      return {
        ok: false,
        diagnostics: schemas.diagnostics,
        display: { ...display, ok: false, errorCount: schemas.diagnostics.length },
      };
    const commands = engine.collectWorldRunCommands(program, table);
    if (commands.diagnostics.length) throw new Error("world.run 必须使用可审核的字面量命令");
    const concurrency = input.max_concurrency ?? 2;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new Error("并发上限须为 1–8");
    const hash = createHash("sha256").update(script).digest("hex");
    const draftPath = join(
      this.options.cwd,
      ".zcode",
      "workflow-drafts",
      `${hash.slice(0, 16)}.ts`,
    );
    await mkdir(resolve(draftPath, ".."), { recursive: true });
    await writeFile(draftPath, script);
    return {
      ok: true,
      model: selectedModel,
      script,
      hash,
      display,
      draftPath,
      name: String(input.name || input.saved?.name || "Step Code 工作流").slice(0, 80),
      lowered: engine.lowerWorkflow(program, table).code,
      askSpecs: engine.buildAskSpecs(table, schemas.schemas),
      commands: new Set(commands.commands),
      caps: { maxConcurrency: concurrency },
      args: input.saved?.args ?? {},
    };
  }

  async create(input, toolCallId, origin = {}) {
    if (!this.guideRead)
      return {
        ok: false,
        reason: "skill_required",
        message: "请先调用 ReadWorkflowGuide 阅读工作流技能。",
      };
    const prepared = await this.prepare(input);
    if (!prepared.ok) {
      this.options.onDisplay?.(toolCallId, prepared.display);
      return prepared;
    }
    return this.confirmAndLaunch(prepared, input, toolCallId, undefined, origin);
  }

  async confirmAndLaunch(prepared, input, toolCallId, runId, origin = {}) {
    const decision = await this.options.confirm({
      toolCallId,
      input: { ...input, script: prepared.script },
      display: prepared.display,
      hash: prepared.hash,
    });
    if (!decision.approved)
      return {
        ok: false,
        status: "denied",
        executed: false,
        message: decision.feedback || "用户拒绝运行，工作流未执行。",
      };
    return this.launch(prepared, toolCallId, runId, origin);
  }

  async recover() {
    for (const record of this.journal.listRunsByParentSession(this.options.sessionId, 64)) {
      if (!["running", "pending"].includes(record.status) || this.active.has(record.runId))
        continue;
      const release = this.ownership.claim(record.runId, true);
      if (!release) continue;
      try {
        this.journal.updateRunStatus(record.runId, "stopped", { stopReason: "interrupted" });
        this.journal.appendEvent(record.runId, {
          type: "run-settled",
          status: "stopped",
          stopReason: "interrupted",
        });
      } finally {
        release();
      }
    }
    this.refresh();
    await hydrateActorTranscripts(this.options, this.journal, this.active);
  }

  async launch(prepared, toolCallId, runId = `step-workflow-${randomUUID()}`, origin = {}) {
    // 既有 run promise 闭包持有不可变来源；并发手动输入不会重写已启动工作流的权限。
    const taskOrigin = structuredClone(origin);
    const release = this.ownership.claim(runId);
    if (!release) throw new Error("此工作流由另一运行实例持有");
    const controller = new AbortController();
    const execution = createNodeExecutionAdapter();
    const executionPort = {
      run: (input) => execution.run({ ...input, signal: controller.signal }),
    };
    const fileSystemPort = createNodeFileSystemAdapter();
    const model = prepared.model ?? this.options.getModel?.() ?? this.options.model;
    const running = { controller, promise: undefined, control: undefined, superseded: false };
    let driver;
    const executionPromise = runWorkflowScript({
      scriptText: prepared.script,
      lowered: prepared.lowered,
      scriptHash: prepared.hash,
      runId,
      name: prepared.name,
      parentSessionId: this.options.sessionId,
      toolCallId,
      cwd: this.options.cwd,
      args: prepared.args,
      caps: prepared.caps,
      askSpecs: prepared.askSpecs,
      validate: engine.validate,
      signal: controller.signal,
      control: { bind: control => { running.control = control; } },
      importedCache: prepared.importedCache,
      resumedFrom: prepared.resumedFrom,
      launch: {
        inputId: this.options.turnId?.() || runId,
        toolCallId,
        parentSessionId: this.options.sessionId,
        phaseNames: prepared.display.causalityGraph?.phases?.map((p) => p.name).filter(Boolean),
        scriptPath: prepared.draftPath,
        subagentModel: formatModelPickerValue(model),
      },
      makeDriver: (sink) =>
        (driver = createStepWorkflowDriver(
          {
            journal: this.journal,
            runId,
            cwd: this.options.cwd,
            command: this.options.command,
            communicationMode: this.options.communicationMode,
            env: readDesktopCredentialEnv(),
            prepareModelExecution: this.options.prepareModelExecution,
            getClientEnvironment: this.options.getClientEnvironment,
            model,
            signal: controller.signal,
            onUiRequest: (request, signal, actor) => this.questions.ask(runId, actor, request, signal, taskOrigin),
            actorRoot: join(this.options.root, "actors"),
            conversationRoot: this.options.conversationRoot,
            onActorChanged: this.options.onActorChanged,
            declaredRunCommands: prepared.commands,
            fileSystemPort,
            executionPort,
            artifactStore: this.artifactStore,
            parentSessionId: this.options.sessionId,
            emit: () => {
              this.refresh();
              this.options.onState?.(this.state);
            },
          },
          sink,
        )),
    });
    const promise = executionPromise.finally(async () => {
      await driver?.closed;
      release();
    });
    running.promise = promise;
    this.active.set(runId, running);
    void promise.then(
      (result) => {
        this.active.delete(runId);
        this.refresh();
        this.options.onState?.(this.state);
        if (running.superseded) return;
        this.options.onCompleted?.({
          runId,
          name: prepared.name,
          status: result.status,
          result: result.artifact,
          error: result.error?.message,
        }, taskOrigin);
      },
      (error) => {
        this.active.delete(runId);
        this.refresh();
        this.options.onState?.(this.state);
        if (running.superseded) return;
        this.options.onCompleted?.({
          runId,
          name: prepared.name,
          status: "errored",
          error: error.message,
        }, taskOrigin);
      },
    );

    return {
      ok: true,
      status: "backgrounded",
      backgroundTaskId: runId,
      runId,
      name: prepared.name,
      scriptPath: prepared.draftPath,
      display: prepared.display,
    };
  }

  cancel(runId) {
    this.assertRun(runId);
    const run = this.active.get(runId);
    if (run) run.controller.abort("user");
    return { ok: true };
  }
  async resume(runId, toolCallId, origin = {}) {
    await this.recover();
    const record = this.assertRun(runId);
    if (this.active.has(runId)) throw new Error("工作流仍在执行");
    if (record.status !== "stopped") throw new Error("只有停止或中断的工作流可以恢复");
    if (record.stopReason === "superseded") throw new Error("此工作流已被修订替代，请恢复后继运行");
    const prepared = await this.prepare({
      script: record.scriptText,
      name: record.name,
      max_concurrency: record.caps.maxConcurrency,
      subagent_model: persistedWorkflowModel(this, runId),
    });
    if (!prepared.ok) return prepared;
    prepared.args = record.args ?? {};
    if (record.resumedFrom) {
      const imported = await buildImportedCache({ journal: this.journal }, record.resumedFrom);
      if (!imported.ok) return { ok: false, reason: imported.reason };
      prepared.resumedFrom = record.resumedFrom;
      prepared.importedCache = imported.cache;
    }
    const answer = await this.options.confirm({
      toolCallId,
      input: { script: prepared.script, name: prepared.name },
      display: prepared.display,
      hash: prepared.hash,
    });
    return answer.approved
      ? this.launch(prepared, toolCallId, runId, origin)
      : { ok: false, status: "denied" };
  }
  async save(input) {
    const prepared = await this.prepare(input);
    if (!prepared.ok) return prepared;
    if (
      savedWorkflows.savedWorkflowExists({
        cwd: this.options.cwd,
        name: input.name,
        scope: input.scope,
        homeDir: this.options.homeRoot ?? this.options.root,
      })
    )
      throw new Error("同名工作流已存在，请换一个名称，避免覆盖");
    return {
      ok: true,
      ...savedWorkflows.saveSavedWorkflow({
        cwd: this.options.cwd,
        name: input.name,
        meta: { description: input.description || input.name },
        script: prepared.script,
        scope: input.scope,
        homeDir: this.options.homeRoot ?? this.options.root,
      }),
    };
  }
  async close() {
    for (const controller of this.snippets) controller.abort("interrupted");
    for (const run of this.active.values()) run.controller.abort("interrupted");
    await Promise.allSettled([...this.active.values()].map((run) => run.promise));
    this.store.close();
    this.ownership.close();
  }
}
