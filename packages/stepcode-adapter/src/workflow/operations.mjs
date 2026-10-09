import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  engine,
  createDynamicWorkflowSnippetService,
  createNodeFileSystemAdapter,
  createNodeExecutionAdapter,
  buildImportedCache,
} from "./dependencies.mjs";

export async function readSource(service, inline, path) {
  if ((inline !== undefined) === (path !== undefined))
    throw new Error("必须提供正文或 path，不能同时提供");
  if (path !== undefined) {
    const [file, root] = await Promise.all([
      realpath(resolve(service.options.cwd, path)),
      realpath(service.options.cwd),
    ]);
    const rel = relative(root, file);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel))
      throw new Error("脚本路径必须在当前工作区内");
    inline = await readFile(file, "utf8");
  }
  if (typeof inline !== "string" || !inline.trim() || Buffer.byteLength(inline) > 262144)
    throw new Error("脚本必须为非空文本且不超过 256KB");
  return inline;
}

export async function evalSnippet(input, toolCallId) {
  const code = await readSource(this, input.code, input.path);
  const timeoutMs = input.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new Error("timeoutMs 必须为 1–600000");
  const program = engine.createWorkflowProgram(code, { facadeDts: engine.SNIPPET_FACADE_DTS });
  const diagnostics = engine.collectDiagnostics(program.program);
  const commands = diagnostics.length
    ? { commands: [], diagnostics }
    : engine.collectWorldRunCommands(program, engine.collectSites(program));
  if (commands.diagnostics.length)
    return { ok: false, diagnostics: commands.diagnostics, executed: false };
  if (commands.commands.length) {
    const answer = await this.options.confirm({
      toolCallId,
      toolName: "EvalWorkflowSnippet",
      input: { code, commands: commands.commands },
      hash: "snippet",
      display: undefined,
    });
    if (!answer.approved) return { ok: false, status: "denied", executed: false };
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  this.snippets.add(controller);
  try {
    const execution = createNodeExecutionAdapter();
    const port = createDynamicWorkflowSnippetService({
      fileSystemPort: createNodeFileSystemAdapter(),
      executionPort: { run: (request) => execution.run({ ...request, signal }) },
    });
    const result = await port.evalSnippet(
      { code, cwd: this.options.cwd, timeoutMs, trace: { traceId: toolCallId ?? randomUUID() } },
      { signal },
    );
    return { ok: result.kind === "completed", ...result };
  } finally {
    this.snippets.delete(controller);
  }
}

export async function amend(input, toolCallId, origin) {
  const runId = input.run_id ?? input.runId;
  const previous = this.assertRun(runId);
  if (this.amending.has(runId)) return { ok: false, reason: "amend_in_progress" };
  this.amending.add(runId);
  try {
    const keys = Object.keys(input).filter((key) => !["run_id", "runId"].includes(key));
    if (keys.length === 1 && keys[0] === "max_concurrency" && this.active.has(runId)) {
      const limit = input.max_concurrency;
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 8))
        throw new Error("并发上限须为 1–8 或 null");
      const control = this.active.get(runId).control;
      if (!control) return { ok: false, reason: "run_not_ready" };
      const changed = control.setMaxConcurrency(limit === null ? 8 : limit);
      if (!changed && !["running", "pending"].includes(this.assertRun(runId).status))
        return { ok: false, reason: "run_not_in_flight" };
      return { ok: true, runId, retuned: true, changed: changed === true };
    }
    const path = input.path ?? input.script_path;
    const script =
      input.script === undefined && path === undefined
        ? previous.scriptText
        : await readSource(this, input.script, path);
    const prepared = await this.prepare({
      ...input,
      script,
      script_path: undefined,
      path: undefined,
      name: input.name ?? previous.name,
      max_concurrency:
        input.max_concurrency === null
          ? 8
          : (input.max_concurrency ?? previous.caps.maxConcurrency),
    });
    if (!prepared.ok) return prepared;
    if (
      prepared.hash === previous.scriptHash &&
      input.max_concurrency === undefined &&
      input.subagent_model === undefined
    )
      return { ok: false, reason: "script_unchanged", executed: false };
    // 编译/确认失败不得中止前驱；成功后由相同 journal 导入缓存，不能伪装成重新 Create。
    const decision = await this.options.confirm({
      toolCallId,
      toolName: "AmendWorkflow",
      input: { ...input, script },
      display: prepared.display,
      hash: prepared.hash,
    });
    if (!decision.approved) return { ok: false, status: "denied", executed: false };
    const successor = `step-workflow-${randomUUID()}`;
    const active = this.active.get(runId);
    if (active) {
      active.superseded = true;
      active.controller.abort({ superseded: successor });
      await active.promise;
    }
    const imported = await buildImportedCache({ journal: this.journal }, runId);
    if (!imported.ok)
      return {
        ok: false,
        reason: imported.reason,
        message: "前驱缺少可信的转录边界，不能伪造已完成缓存。",
      };
    prepared.args = previous.args ?? {};
    prepared.importedCache = imported.cache;
    prepared.resumedFrom = runId;
    const result = await this.launch(prepared, toolCallId, successor, origin);
    return { ...result, supersedes: runId };
  } finally {
    this.amending.delete(runId);
  }
}
