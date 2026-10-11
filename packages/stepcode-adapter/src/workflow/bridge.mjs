/* oxlint-disable eslint(max-lines) -- P1-01 追加 disposeSession（close() 全量语义的
 * 单会话版）：必须与 services/pending/states 三个 Map 闭包私有状态同域，拆出反而
 * 会把这些私有态公有化；skipComments 口径下超出的 8 行全部是该函数的实现。 */
import { readWorkflowGuide } from "./guide.mjs";
import { mkdir, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { workflowToolName } from "./catalog.mjs";
import { confirmWorkflow, discardFinishedConfirmations } from "./confirmation.mjs";
import { WorkflowToolAdmission } from "./tool-admission.mjs";
import { isNativeToolPermission, nativeToolPermissionCallId, resolveNativePermissionAction } from "../permission-policy.mjs";
import { askDesktopQuestionnaire } from "../questionnaire-interaction.mjs";
export { installWorkflowPlugin } from "./plugin-install.mjs";

/** 桥接只拥有交互等待；运行与投影的事实来自同一个持久工作流服务。 */
export function createWorkflowBridge(options) {
  const services = new Map(),
    pending = new Map();
  const admission = new WorkflowToolAdmission(options.rows, workflowToolName, options.toolAdmissionTimeoutMs);
  const guideSessions = new Set();
  function permission(sessionId, request, signal) {
    if (signal?.aborted) return Promise.resolve({ cancelled: true });
    const questionnaire = askDesktopQuestionnaire({ sessionId, request, signal, pending, options });
    if (questionnaire) return questionnaire;
    // 四模式策略（P0-05，语义表见 permission-policy.mjs）：只对原生工具授权生效，
    // 业务问题/追问恒弹窗。yolo 放行（Composer 完全访问是会话级明确授权，不能只
    // 显示 yolo 而丢掉执行侧语义）；plan 直接拒（{confirmed:false}，底座视作用户
    // 拒绝——文案上与原生 strict 的 'Read-only mode blocks' 有别，见策略文件注释）。
    if (isNativeToolPermission(request)) {
      const action = resolveNativePermissionAction(options.session(sessionId)?.mode, request);
      if (action === "allow") return Promise.resolve({ confirmed: true });
      if (action === "deny") return Promise.resolve({ confirmed: false });
    }
    if (request.method === "input" || request.method === "select") return askUserInput(sessionId, request, signal);
    if (request.method !== "confirm") return Promise.resolve({ cancelled: true });
    return new Promise((resolve) => {
      const interactionId = `step-permission-${randomUUID()}`;
      // 同批工具可能已全部产生行；原生 Call ID 才能确定本次审批对象，不能猜最后一行。
      const callId = nativeToolPermissionCallId(request);
      const row = options.rows(sessionId).findLast((row) => row.kind === "toolCall" && (!callId || row.toolCallId === callId));
      const nativePreview = callId && row?.input !== undefined
        ? { toolName: row.toolName, input: row.input, reason: request.message }
        : request.message;
      const resumeStatus = row?.status === "running" ? "running" : "inputStreaming";
      if (callId && row) { row.status = "pendingApproval"; row.interactionId = interactionId; }
      const settleRow = approved => {
        if (!callId || row?.interactionId !== interactionId) return;
        // 原生会先批量预审批；批准不等于已经执行，恢复审批前状态并等待实际执行事件。
        if (row.status === "pendingApproval") row.status = approved ? resumeStatus : "cancelled";
        delete row.interactionId;
      };
      const abort = () => {
        pending.delete(interactionId);
        settleRow(false);
        resolve({ cancelled: true });
        options.changed(sessionId);
      };
      pending.set(interactionId, {
        sessionId,
        nativePermission: Boolean(callId),
        resolve: (decision) => {
          signal?.removeEventListener("abort", abort);
          settleRow(decision.approved);
          resolve({ confirmed: decision.approved });
        },
        item: {
          interactionId,
          kind: "permission",
          anchorRowId: row?.rowId ?? null,
          createdAt: Date.now(),
          payload: {
            kind: "permission",
            toolCallId: callId ?? request.id,
            toolName: callId && row?.toolName ? row.toolName : request.title || "Step 子任务",
            summary: request.title || "批准子任务操作",
            detail: nativePreview,
            options: [
              { optionId: "allow", label: "允许一次", kind: "allowOnce" },
              { optionId: "deny", label: "拒绝", kind: "deny" },
            ],
          },
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      options.changed(sessionId);
    });
  }
  /**
   * input/select 追问 → userInput pending（UI 弹窗只有 prompt 一个文本字段，必须把
   * title+message 折叠进 prompt——正文在 message，只透传 title 会丢正文）。响应语义
   * 是 {value}；条目带 valueKind 标记，resolve() 把 UI 答案（input=freeText、
   * select=optionId）折成 value，resolve 闭包把任何无 string value 的 decision 统一
   * 兜成 {cancelled:true}——resolve()/cancelPending()/abort/close() 四路全兜住，
   * close() 零改动。
   */
  function askUserInput(sessionId, request, signal) {
    const selectOptions =
      request.method === "select"
        ? Array.isArray(request.options)
          ? request.options.map((option) => ({ optionId: String(option), label: String(option) }))
          : []
        : null;
    if (selectOptions && selectOptions.length === 0) return Promise.resolve({ cancelled: true });
    return new Promise((resolve) => {
      const interactionId = `step-input-${randomUUID()}`;
      const row = options.rows(sessionId).findLast((row) => row.kind === "toolCall");
      const coerce = (decision) =>
        resolve(typeof decision?.value === "string" && decision.value ? { value: decision.value } : { cancelled: true });
      const abort = () => {
        pending.delete(interactionId);
        coerce();
        options.changed(sessionId);
      };
      pending.set(interactionId, {
        sessionId,
        valueKind: request.method,
        resolve: (decision) => {
          signal?.removeEventListener("abort", abort);
          coerce(decision);
        },
        item: {
          interactionId,
          kind: "userInput",
          anchorRowId: row?.rowId ?? null,
          createdAt: Date.now(),
          payload: {
            kind: "userInput",
            toolCallId: request.id,
            toolName: request.title || "Step 追问",
            prompt: [
              request.title,
              request.message,
              typeof request.placeholder === "string" && request.placeholder ? `（提示：${request.placeholder}）` : null,
            ]
              .filter(Boolean)
              .join("\n"),
            freeText: request.method === "input",
            ...(selectOptions ? { options: selectOptions } : {}),
          },
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      options.changed(sessionId);
    });
  }
  async function service(sessionId) {
    if (!sessionId) throw new Error("工作流缺少会话标识");
    if (!services.has(sessionId)) {
      const session = options.session(sessionId);
      if (!session) throw new Error("找不到工作流所属会话");
      const promise = (async () => {
        const { StepWorkflowService } = await import("./service.mjs");
        const root = join(options.root, "workflows", encodeURIComponent(sessionId));
        await mkdir(root, { recursive: true });
        return new StepWorkflowService({
          root,
          homeRoot: options.root,
          sessionId,
          cwd: session.workspace.workspacePath,
          model: session.modelSelection,
          getModel: () => options.session(sessionId)?.modelSelection ?? session.modelSelection,
          command: options.command,
          communicationMode: options.communicationMode,
          conversationRoot: join(options.root, "conversations"),
          onActorChanged: id => options.changed(id),
          prepareModelExecution: selection => options.prepareModelExecution?.(sessionId, selection),
          getClientEnvironment: options.getClientEnvironment,
          turnId: options.turnId,
          onUiRequest: (request, signal) => permission(sessionId, request, signal),
          confirm: request => confirmWorkflow(options, pending, sessionId, request),
          onDisplay: (id, display) => {
            const row = options.rows(sessionId).find((row) => row.toolCallId === id);
            if (row) row.display = display;
            options.changed(sessionId);
          },
          onState: (state) => {
            states.set(sessionId, state);
            options.changed(sessionId);
          },
          onCompleted: (result, origin) => options.completed(sessionId, result, origin),
          onQuestion: (question, origin) => options.completed(sessionId, { ...question, status: "waiting_question", message: "子代理等待回答，请使用 ResolveWorkflowQuestion；没有把握时先询问用户。" }, origin),
        });
      })();
      services.set(sessionId, promise);
      promise.catch(() => services.delete(sessionId));
    }
    return services.get(sessionId);
  }
  const states = new Map();
  return {
    permission,
    cancelPending(sessionId) {
      admission.cancel(sessionId);
      void services.get(sessionId)?.then(instance => {
        for (const controller of instance.snippets) controller.abort("user");
      }).catch(() => {});
      for (const [id, request] of pending) {
        if (request.sessionId !== sessionId) continue;
        pending.delete(id);
        request.resolve({ approved: false });
      }
      options.changed(sessionId);
    },
    async request({ method, params = {} }, context) {
      if(method === "ReadWorkflowGuide") {
        if(!options.session(context.sessionId))throw new Error("找不到工作流所属会话");
        const guide=await readWorkflowGuide(params.section);guideSessions.add(context.sessionId);return guide;
      }
      const instance = await service(context.sessionId);
      if(guideSessions.has(context.sessionId))instance.guideRead=true;
      const toolCallId = ["CreateWorkflow", "ResumeWorkflowRun", "AmendWorkflow", "EvalWorkflowSnippet"].includes(method)
        ? await admission.claim(context.sessionId, method, params) : undefined;
      // 来源由 PID relay 的真实输入上下文注入；不得在完成时读另一个正在运行的输入。
      const origin = { automationId: context.activeAutomationId, toolDisallowlist: context.toolDisallowlist,
        botDeliveryTarget: context.botDeliveryTarget };
      switch (method) {
        case "ReadWorkflowGuide":
          return instance.guide(params.section);
        case "CreateWorkflow":
          return instance.create(params, toolCallId, origin);
        case "EvalWorkflowSnippet":
          return instance.evalSnippet(params, toolCallId, context.signal);
        case "AmendWorkflow":
          return instance.amend(params, toolCallId, origin);
        case "ResolveWorkflowQuestion":
          return instance.resolveQuestion(params);
        case "GetWorkflowRun":
          return instance.detail(params.runId);
        case "ListWorkflowRuns":
          return { runs: instance.list() };
        case "CancelWorkflowRun":
          return instance.cancel(params.runId);
        case "ResumeWorkflowRun":
          return instance.resume(params.runId, toolCallId, origin);
        case "SaveWorkflow":
          return instance.save(params);
        case "ListSavedWorkflows":
          return instance.listSaved(params);
        default:
          throw new Error("未知工作流工具");
      }
    },
    service,
    observeTools(sessionId) {
      discardFinishedConfirmations(options, pending, sessionId);
      admission.observe(sessionId);
    },
    async savedRuns(params) {
      const runs = [],
        limit = Math.max(1, Math.min(50, params.limit ?? 20));
      let directories;
      try {
        directories = await readdir(join(options.root, "workflows"), { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        directories = [];
      }
      for (const directory of directories) {
        if (!directory.isDirectory()) continue;
        const sessionId = decodeURIComponent(directory.name),
          session = options.session(sessionId);
        if (
          !session ||
          (params.scope !== "global" &&
            session.workspace.workspacePath !== params.workspace.workspacePath)
        )
          continue;
        const instance = await service(sessionId);
        for (const record of instance.journal.listRuns({
          limit: limit + 1,
          ...(params.name ? { name: params.name } : {}),
        })) {
          if (record.parentSessionId !== sessionId) continue;
          runs.push({
            runId: record.runId,
            ...(record.name ? { name: record.name } : {}),
            status: record.status,
            ...(record.stopReason ? { stopReason: record.stopReason } : {}),
            createdAt: record.timeCreated,
            updatedAt: record.timeUpdated,
            spentTokens: record.spentTokens ?? 0,
            parentSessionId: sessionId,
            ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
            cwd: session.workspace.workspacePath,
          });
        }
      }
      runs.sort((a, b) => b.updatedAt - a.updatedAt);
      return { runs: runs.slice(0, limit), ...(runs.length > limit ? { truncated: true } : {}) };
    },
    async hydrate(sessionId) {
      // 没有工作流历史的普通会话无需加载编译器和 journal 服务。
      try { await access(join(options.root,"workflows",encodeURIComponent(sessionId),"workflow-runs.sqlite")); }
      catch(error) { if(error.code === "ENOENT")return;throw error; }
      const instance = await service(sessionId);
      await instance.recover();
      states.set(sessionId, instance.refresh());
    },
    async listRuns(sessionId) {
      if (!sessionId) throw new Error("工作流缺少会话标识");
      // 普通聊天的目录查询不能加载执行编译器或创建空数据库，避免首帧被同步模块初始化阻塞。
      if (!services.has(sessionId)) {
        try { await access(join(options.root, "workflows", encodeURIComponent(sessionId), "workflow-runs.sqlite")); }
        catch (error) { if (error.code === "ENOENT") return []; throw error; }
      }
      return (await service(sessionId)).list();
    },
    async isQuestionPending(sessionId, { runId, questionId }) {
      // 通知只引用问题状态，不加载一个新服务来复活重启前的等待。
      if (!services.has(sessionId)) return false;
      const instance = await services.get(sessionId);
      return instance.active.has(runId) && instance.questions.list(runId).some(q => q.question_id === questionId);
    },
    snapshot(sessionId) {
      const backgroundWorks = (states.get(sessionId)?.runs ?? [])
        .filter((run) => ["running", "pending"].includes(run.status))
        .map((run) => {
          const row = options.rows(sessionId).find((row) => row.toolCallId === run.toolCallId);
          return {
            workId: run.runId,
            kind: "workflow",
            title: row?.input?.name || "工作流",
            status: "running",
            startedAt: row?.createdAt ?? 0,
            cancellable: true,
            anchorRowId: row?.rowId ?? null,
          };
        });
      return {
        backgroundWorks,
        pendingInteractions: [...pending.values()]
          .filter((p) => p.sessionId === sessionId)
          .map((p) => p.item),
        ...(states.has(sessionId) ? { workflowRuns: states.get(sessionId) } : {}),
      };
    },
    resolve(sessionId, interactionId, answer) {
      discardFinishedConfirmations(options, pending, sessionId);
      const request = pending.get(interactionId);
      if (!request || request.sessionId !== sessionId)
        throw new Error("确认请求已失效或不属于当前会话");
      if (request.valueKind === "questionnaire") {
        request.validate(answer);
        pending.delete(interactionId);
        request.resolve(answer);
        options.changed(sessionId);
        return;
      }
      pending.delete(interactionId);
      if (request.valueKind) {
        // input/select：答案折成 value（input=freeText、select=optionId）；缺字段交给
        // 条目闭包统一兜成 {cancelled:true}（fail-closed，对齐底座 input/select 语义）。
        const value = request.valueKind === "select" ? answer?.optionId : answer?.freeText;
        request.resolve(typeof value === "string" && value ? { value } : undefined);
        options.changed(sessionId);
        return;
      }
      const approved = answer?.optionId === "allow";
      const row = options
        .rows(sessionId)
        .find((row) => row.toolCallId === request.item.payload.toolCallId);
      if (row && !request.workflowConfirmation && !request.nativePermission) {
        row.status = approved ? "running" : "cancelled";
        delete row.interactionId;
      }
      request.resolve({ approved, feedback: answer?.freeText });
      options.changed(sessionId);
    },
    async close() {
      admission.cancel();
      for (const request of pending.values()) request.resolve({ approved: false });
      pending.clear();
      await Promise.allSettled(
        [...services.values()].map(async (promise) => (await promise).close()),
      );
    },
    /**
     * 释放单个会话的工作流资源（close() 全量语义的单会话版，P1-01 deleteSession 消费）：
     * - resolve 该会话尚未决的 pending 交互（批准等待被 deleteSession 打断时按拒绝收口，
     *   不悬挂 resolve 回调；valueKind 分支以 {approved:false} 兜——与 close() 全量版
     *   同款「缺字段条目闭包兜成 cancelled」语义）；states 投影一并清（防已删会话再被
     *   快照广播）；
     * - close 该会话的 StepWorkflowService（abort 活动 run + 关 journal/store sqlite 句柄）——
     *   必须先于 workflows/<enc(id)> 目录 rename（Windows 上句柄未释放时目录改名会失败），
     *   close 失败如实向上抛（deleteSession 整体失败=零改动可重试）。
     * 服务从未创建成功（构造 promise 已 reject 并从 Map 自清）时静默跳过——等价于
     * 「该会话无工作流资源」。
     */
    async disposeSession(sessionId) {
      admission.cancel(sessionId);
      const promise = services.get(sessionId);
      services.delete(sessionId);
      states.delete(sessionId);
      for (const [id, request] of pending) {
        if (request.sessionId !== sessionId) continue;
        pending.delete(id);
        request.resolve({ approved: false });
      }
      if (!promise) return;
      let instance;
      try {
        instance = await promise;
      } catch {
        // 构造失败=服务从未存在（catch 里 services.delete 已自清），视为无资源可释放。
        return;
      }
      await instance.close();
    },
  };
}
