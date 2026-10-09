import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StepCodeRpcClient } from "../rpc-client.mjs";
import { promptUntilSettled, abortUntilSettled } from "./ask-events.mjs";
import { engine, executeWorldRead, executeArtifactPublish } from "./dependencies.mjs";
import { WorkflowActorTranscript } from "./actor-transcript.mjs";
import { createStepActorActivity } from "./step-activity.mjs";
import { prepareProviderRequestOptions, discardProviderRequestOptions } from "../provider-request-options.mjs";
import { readModelConfigSignatures, modelEnvironmentSignature } from "../model-config-signatures.mjs";
import { mergeDesktopEnvironment } from "../desktop-shell.mjs";
import { resolveThoughtLevel } from "../thought-level-selection.mjs";
import { captureNativeTranscript, seedNativeTranscript } from "./native-transcript.mjs";

const refKey = (ref) => `${ref.siteId}@${ref.ordinal}`;

/** WorkflowDriver 的 Step RPC 实现；引擎负责校验、调度、重放和结算。 */
export function createStepWorkflowDriver(options, sink) {
  const actors = new Map(),
    asks = new Map();
  let disposed = false;
  let closed = Promise.resolve();
  function cancelAsk(instance) {
    const ask = asks.get(refKey(instance));
    if (!ask) return;
    ask.cancelled = true;
    ask.controller.abort();
    const actor = actors.get(ask.session.id);
    if (actor && !actor.cancellation) {
      actor.cancellation = abortUntilSettled(actor.client);
      // dispose 随后等待同一 Promise；这里先接住异常，避免两个生命周期边界间出现未处理拒绝。
      void actor.cancellation.catch(() => {});
    }
  }
  async function runAsk(ask, correction = "") {
    const actor = actors.get(ask.session.id);
    if (!actor || disposed || ask.cancelled) return;
    try {
      let tools = 0;
      const observeActivity = createStepActorActivity(
        sink,
        ask.instance,
        () => !disposed && !ask.cancelled && asks.get(refKey(ask.instance)) === ask,
      );
      const unsubscribe = actor.client.onEvent((event) => {
        // 原 UI 只认 node-executing；仅回报 dispatched/progress 会让在工作的 actor 始终算等待。
        observeActivity(event);
        if (event.type !== "tool_execution_start") return;
        // 真实工具写入前关闭前驱世界缓存；未知工具按可能写入处理。
        if (!/^(read_file|read|find_files|search_files|list_directory|find_tools|clarify_user)$/.test(event.toolName ?? "")) sink.askMutating(ask.instance);
        tools++;
        sink.askProgress(ask.instance, {
          turn: ask.turn,
          toolCalls: tools,
          lastTool: { name: event.toolName ?? "tool" },
        });
      });
      let events;
      try {
        await options.prepareModelExecution?.(options.model);
        const latestEnv = mergeDesktopEnvironment(process.env, options.getClientEnvironment ? await options.getClientEnvironment() : options.env);
        const signatures = await readModelConfigSignatures(undefined, latestEnv);
        const key = `${options.model.providerId}\0${options.model.modelId}`;
        if (actor.modelSignature !== signatures.get(key) || actor.envSignature !== modelEnvironmentSignature(latestEnv)) throw new Error("子任务模型配置已变化，请恢复工作流后继续");
        const contract = ask.message.typed
          ? `\n最后只返回符合下列 JSON Schema 的 JSON 值，不加 Markdown：\n${JSON.stringify(ask.message.schema)}`
          : "";
        actor.transcript.beginAsk(`${correction || ask.message.instructions}${contract}`);
        await actor.transcript.flush();
        const requestId = `${options.runId}-${refKey(ask.instance)}-${ask.turn}`;
        const policy = await prepareProviderRequestOptions(actor.client, { ...options.model, requestId });
        if (options.model.options?.reasoningLevel && !policy.reasoningMapped) {
          const level = resolveThoughtLevel(options.model.options.reasoningLevel, await actor.client.getAvailableThinkingLevels(), (await actor.client.getState()).thinkingLevel);
          if (level) await actor.client.setThinkingLevel(level);
        }
        try { events = await promptUntilSettled(
          actor.client,
          `${actor.persona.system ?? ""}\n${correction || ask.message.instructions}${contract}`,
          ask.controller.signal,
        ); }
        catch (error) { if (error.stepRejected === true) await discardProviderRequestOptions(actor.client, { ...options.model, requestId }); throw error; }
      } finally {
        unsubscribe();
      }
      if (ask.cancelled || disposed) return;
      // SDK 自动重试的中间错误不是最终失败，按最终助手消息判定本次 ask。
      const finalAssistant = events.findLast(event => event.type === "message_end" && event.message?.role === "assistant");
      const failed = finalAssistant && ["error", "aborted"].includes(finalAssistant.message?.stopReason) ? finalAssistant : undefined;
      if (failed) throw new Error(failed.message.errorMessage || "Step 子任务被中断");
      const finalText = (await actor.client.getLastAssistantText()) ?? "";
      const state = await actor.client.getState();
      await writeFile(
        actor.file,
        JSON.stringify({ sessionFile: state.sessionFile, model: options.model }),
      );
      await actor.transcript.flush();
      const messageBoundary = await captureNativeTranscript(actor.client, options.actorRoot, ask.session.id);
      const tokens = events
        .filter((event) => event.type === "message_end")
        .reduce((sum, event) => sum + (event.message?.usage?.totalTokens ?? 0), 0);
      sink.askStats(ask.instance, { tokens, toolCalls: tools, turns: 1, worldToolCalls: tools });
      ask.turn++;
      if (ask.message.typed) {
        try {
          const json = finalText
            .trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "");
          sink.askSubmitAttempted(ask.instance, JSON.parse(json));
        } catch {
          sink.askTurnEnded(ask.instance, finalText);
        }
      } else sink.askTurnEnded(ask.instance, finalText);
      const completed = options.journal.getNode(options.runId, ask.instance.siteId, ask.instance.ordinal);
      if (completed?.status === "completed") options.journal.putNode({ ...completed, messageBoundary });
    } catch (error) {
      await actor.transcript
        ?.finish(ask.cancelled || disposed ? "completedInterrupted" : "failed")
        .catch(() => {});
      if (!ask.cancelled && !disposed)
        sink.askFailed(ask.instance, new engine.WorkflowError("DriverError", error.message));
    }
  }
  return {
    get closed() {
      return closed;
    },
    journal: options.journal,
    emit: options.emit,
    async createActorSession(ref, persona, seed) {
      const id = `${options.runId}-${refKey(ref)}`;
      const file = join(options.actorRoot, `${encodeURIComponent(id)}.json`);
      await mkdir(options.actorRoot, { recursive: true });
      await options.prepareModelExecution?.();
      const client = new StepCodeRpcClient({
        command: options.command,
        communicationMode: options.communicationMode ?? "required",
        cwd: options.cwd,
        env: options.getClientEnvironment ? await options.getClientEnvironment() : options.env,
        onUiRequest: options.onUiRequest
          ? (request) => options.onUiRequest(request, options.signal, id)
          : undefined,
      });
      const startupEnv = mergeDesktopEnvironment(process.env, client.options.env), startupSignatures = await readModelConfigSignatures(undefined, startupEnv);
      actors.set(id, { client, persona, file });
      try {
        options.signal?.throwIfAborted();
        await client.start();
        options.signal?.throwIfAborted();
        let saved;
        try {
          saved = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (saved?.sessionFile) {
          const result = await client.request({
            type: "switch_session",
            sessionPath: saved.sessionFile,
          });
          if (!result.success || result.data?.cancelled) throw new Error("无法恢复工作流子会话");
        } else {
          await client.newSession();
          if (seed) await seedNativeTranscript(client, options.actorRoot, seed, id, options.cwd);
        }
        options.signal?.throwIfAborted();
        await client.setModel(options.model.providerId, options.model.modelId);
        await options.prepareModelExecution?.(options.model);
        const state = await client.getState();
        await writeFile(
          file,
          JSON.stringify({ sessionFile: state.sessionFile, model: options.model }),
        );
        const transcript = await WorkflowActorTranscript.open({
          conversationRoot: options.conversationRoot ?? join(options.actorRoot, "conversations"),
          sessionId: id,
          nativeSessionFile: state.sessionFile,
          cwd: options.cwd,
          model: options.model,
          name: options.journal.getActor(options.runId, ref.siteId, ref.ordinal)?.name,
          parentSessionId: options.parentSessionId,
          runId: options.runId,
          onChanged: options.onActorChanged,
        });
        await transcript.flush();
        const unsubscribe = client.onEvent((event) => transcript.handle(event));
        actors.set(id, { client, persona, file, transcript, unsubscribe,
          modelSignature: startupSignatures.get(`${options.model.providerId}\0${options.model.modelId}`), envSignature: modelEnvironmentSignature(startupEnv) });
        options.signal?.throwIfAborted();
        return { id };
      } catch (error) {
        actors.delete(id);
        await client.stop().catch(() => {});
        throw error;
      }
    },
    startAsk(session, instance, message) {
      const ask = {
        session,
        instance,
        message,
        turn: 1,
        cancelled: false,
        controller: new AbortController(),
      };
      asks.set(refKey(instance), ask);
      void runAsk(ask);
    },
    respondToSubmit(instance, verdict) {
      const ask = asks.get(refKey(instance));
      if (!ask) return;
      if (verdict.kind === "accept") {
        asks.delete(refKey(instance));
        return;
      }
      const correction =
        verdict.kind === "reject"
          ? `结果未通过类型校验，请纠正后重新提交 JSON。错误：${JSON.stringify(verdict.violations)}`
          : "请提交要求的最终 JSON 结果。";
      queueMicrotask(() => void runAsk(ask, correction));
    },
    cancelAsk,
    executeWorldRead: (op, args) => executeWorldRead(options, op, args),
    executeArtifactPublish: (request) => executeArtifactPublish(options, request),
    dispose() {
      disposed = true;
      for (const ask of asks.values()) cancelAsk(ask.instance);
      closed = Promise.allSettled(
        [...actors.values()].map(async (actor) => {
          try {
            // 原实现在 abort 后立即关闭子进程，工具结果尚未保存；恢复会得到 No result provided 假结果。
            await actor.cancellation;
            await actor.transcript?.flush();
          } finally {
            await actor.client.stop();
            actor.unsubscribe?.();
            await actor.transcript?.finish("completedInterrupted");
          }
        }),
      );
    },
  };
}
