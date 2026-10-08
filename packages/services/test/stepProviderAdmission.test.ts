import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import { zcodeProtocolMethods, zcodePrepareModelExecutionResultSchema } from "@zcode/shared";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.ts";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.ts";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.ts";
import { setDataBaseDir } from "../src/paths.ts";
import { createStepCommunityProviderView } from "../src/model-provider/stepCommunityModelSelection.ts";
import {
  buildCliSyncProviders,
  createStepCliProviderSyncSink,
  syncCustomProvidersToStepCliModelsFile,
  assertStepCliModelExecutionAvailable,
} from "../src/model-provider/cliProviderSync.ts";
import { awaitModelCommandAdmission } from "../src/zcode-agent/modelCommandAdmission.ts";

test("已有Host client的模型命令必须等待最新投影失败；停止和历史读取保持可用", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-admission-"));
  const modelsFilePath = join(root, "models.json");
  const messages = new Emitter<any>();
  const closed = new Emitter<any>();
  const forwarded: string[] = [];
  const replyWaiters = new Map<string, (result: unknown) => void>();
  class Client extends ZCodeProtocolClient {
    override async respond(id: string | number, result: unknown) {
      replyWaiters.get(String(id))?.(result);
    }
    override async respondError(id: string | number, error: { code: number; message: string }) {
      replyWaiters.get(String(id))?.({ error });
    }
    override async request<T = unknown>(method: string, params?: any): Promise<T> {
      forwarded.push(method === "v4/command" ? `v4:${params.type}` : method);
      return {
        status: "accepted",
        revisionAtDecision: 1,
        snapshot: { messages: [], session: { status: "idle" } },
      } as T;
    }
  }
  const client = new Client({
    kind: "memory",
    onMessage: messages.event,
    onClose: closed.event,
    send: async () => {
      throw new Error("unexpected transport send");
    },
    dispose() {},
  });
  const originalGetClient = ZCodeAgentProcessManager.prototype.getClient;
  ZCodeAgentProcessManager.prototype.getClient = async () => client;
  setDataBaseDir(root);
  function reverse(id: string, workspacePath: string, extra: Record<string, unknown> = {}) {
    const result = new Promise<unknown>((resolve) => replyWaiters.set(id, resolve));
    messages.fire({
      id,
      method: zcodeProtocolMethods.interactionPrepareModelExecution,
      params: {
        workspace: { workspacePath, workspaceKey: workspacePath },
        sessionId: "fixture-session",
        ...extra,
      },
    });
    return result;
  }
  let service: ReturnType<typeof createZCodeAgentService> | undefined;
  try {
    const view = {
      providerId: "fixture-provider",
      config: {
        access: { type: "api-key", apiKey: "sk-fixture-old-key" },
        api: { type: "openai-responses", baseUrl: "http://localhost:1234/v1" },
      },
      models: [{ modelId: "fixture-model" }],
    };
    const desired = buildCliSyncProviders([view.providerId], [view]).providers;
    let publicationGate: Promise<void> | undefined;
    const sink = createStepCliProviderSyncSink(async (providers: typeof desired) => {
      await publicationGate;
      await syncCustomProvidersToStepCliModelsFile({}, providers, { modelsFilePath });
    });
    await sink.sync(desired);
    let executableProviders = [view];
    service = createZCodeAgentService({
      modelSelectionReadinessSource: {
        getView: async () => ({ revision: 1, providers: [createStepCommunityProviderView()] }),
      },
      waitForModelAdmission: async (selection) => {
        await sink.wait();
        if (selection) assertStepCliModelExecutionAvailable(selection, executableProviders);
      },
    } as Parameters<typeof createZCodeAgentService>[0]);
    const workspace = { workspacePath: root };
    const session = { ...workspace, sessionId: "fixture-session" };
    assert.equal((await service.initialize(workspace)).available, true);
    const document = JSON.parse(await readFile(modelsFilePath, "utf8"));
    document.providers[view.providerId].manual = true;
    await writeFile(modelsFilePath, JSON.stringify(document));
    // Registry 清空 key 后 empty desired；文件冲突保留 old key，但 admission 必须拒绝下一轮。
    await assert.rejects(sink.sync([]), /冲突/);
    assert.deepEqual(
      zcodePrepareModelExecutionResultSchema.parse(await reverse("fixture-reverse-failed", root)),
      {
        ready: false,
        error: {
          code: "model_projection_failed",
          message: "Step CLI 供应商配置冲突（fixture-provider 已被手工修改）；同步中止且未改动配置",
        },
      },
    );
    assert.deepEqual(await reverse("fixture-reverse-wrong-workspace", join(root, "different")), {
      error: { code: -32602, message: "Invalid model execution admission scope" },
    });
    assert.deepEqual(
      await reverse("fixture-reverse-secret-rejected", root, {
        apiKey: "sk-fixture-not-allowed-in-admission",
      }),
      { error: { code: -32602, message: "Invalid model execution admission scope" } },
    );
    const error = /供应商配置冲突/;
    await assert.rejects(
      service.sendPrompt({ ...session, inputId: "fixture-send", content: "must not execute" }),
      error,
    );
    await assert.rejects(
      service.testModelConnectivity({
        ...workspace,
        selection: { providerId: view.providerId, modelId: "fixture-model" },
      }),
      error,
    );
    await assert.rejects(
      service.setModel({
        ...session,
        model: { providerId: view.providerId, modelId: "fixture-model" },
      }),
      error,
    );
    for (const [type, payload] of [
      ["sendText", { text: "must not execute" }],
      ["createSession", { workspaceId: "fixture", firstInput: { text: "must not execute" } }],
      [
        "switchModelConfig",
        { modelSelection: { providerId: view.providerId, modelId: "fixture-model" } },
      ],
      ["sendQueuedNow", { queueItemId: "fixture-queue" }],
      ["setAutoDrain", { autoDrain: true }],
    ] as const)
      await assert.rejects(
        service.sendConversationCommandV4({
          ...workspace,
          envelope: {
            commandId: `fixture-${type}`,
            sessionId: session.sessionId,
            type,
            payload,
          },
        } as any),
        error,
      );
    assert.deepEqual(forwarded, []);
    await service.sendConversationCommandV4({
      ...workspace,
      envelope: {
        commandId: "fixture-stop",
        sessionId: session.sessionId,
        type: "stop",
        payload: {},
      },
    } as any);
    await service.readSessionMessages(session);
    assert.deepEqual(forwarded, ["v4:stop", "session/messages"]);
    delete document.providers[view.providerId].manual;
    await writeFile(modelsFilePath, JSON.stringify(document));
    let release!: () => void;
    publicationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publishing = sink.sync(desired);
    const queuedPrepare = reverse("fixture-reverse-queued-execution", root);
    const send = service.sendPrompt({
      ...session,
      inputId: "fixture-recover",
      content: "after successful publication",
    });
    await service.sendConversationCommandV4({
      ...workspace,
      envelope: {
        commandId: "fixture-stop-waiting",
        sessionId: session.sessionId,
        type: "stop",
        payload: {},
      },
    } as any);
    await service.readSessionMessages(session);
    assert.deepEqual(forwarded, ["v4:stop", "session/messages", "v4:stop", "session/messages"]);
    release();
    await publishing;
    assert.deepEqual(await queuedPrepare, { ready: true });
    await send;
    assert.equal(forwarded.at(-1), "session/send");
    // 无 ownership 的旧项依法保留；成功发布空 desired 不代表该模型仍可由桌面执行。
    const oldUnowned = JSON.parse(await readFile(modelsFilePath, "utf8"));
    delete oldUnowned._stepcodeDesktopProviders;
    const preserved = JSON.stringify(oldUnowned);
    await writeFile(modelsFilePath, preserved);
    executableProviders = [];
    await sink.sync([]);
    assert.equal(await readFile(modelsFilePath, "utf8"), preserved);
    assert.deepEqual(await reverse("fixture-reverse-bootstrap-config", root), { ready: true });
    const deletedModel = zcodePrepareModelExecutionResultSchema.parse(
      await reverse("fixture-reverse-deleted-selection", root, {
        selection: { providerId: view.providerId, modelId: "fixture-model" },
      }),
    );
    assert.equal(deletedModel.ready, false);
    if (deletedModel.ready) throw new Error("deleted desktop model cannot be admitted");
    assert.equal(deletedModel.error.code, "model_selection_unavailable");
    assert.match(deletedModel.error.message, /已删除、禁用或不可执行/);
    executableProviders = [
      { ...view, providerId: "new-valid-provider", models: [{ modelId: "new-valid-model" }] },
    ];
    assert.deepEqual(
      await reverse("fixture-reverse-new-selection-recovers", root, {
        selection: { providerId: "new-valid-provider", modelId: "new-valid-model" },
      }),
      { ready: true },
    );
  } finally {
    await service?.disposeAllAndWait();
    client.dispose();
    messages.dispose();
    closed.dispose();
    ZCodeAgentProcessManager.prototype.getClient = originalGetClient;
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
});

test("官方legacy/API/订阅通道沿公共连接事实，其他模型沿Registry资格", () => {
  const custom = { providerId: "unfamiliar-provider", models: [{ modelId: "valid-model" }] };
  const stepProviders = ["step", "step-api", "step-plan"].map((providerId) => ({
    providerId,
    models: [{ modelId: "official-model" }],
  }));
  for (const provider of stepProviders) {
    assertStepCliModelExecutionAvailable(
      { providerId: provider.providerId, modelId: "official-model" },
      [],
      stepProviders,
    );
    assert.throws(
      () =>
        assertStepCliModelExecutionAvailable(
          { providerId: provider.providerId, modelId: "missing-model" },
          [],
          stepProviders,
        ),
      /不可执行/,
    );
    assert.throws(
      () =>
        assertStepCliModelExecutionAvailable(
          { providerId: provider.providerId, modelId: "official-model" },
          stepProviders,
          [],
        ),
      /不可执行/,
    );
  }
  assertStepCliModelExecutionAvailable({ providerId: custom.providerId, modelId: "valid-model" }, [
    custom,
  ]);
  assert.throws(
    () =>
      assertStepCliModelExecutionAvailable(
        { providerId: "manual-cli-only", modelId: "retained-key-model" },
        [custom],
      ),
    /不可执行/,
  );
});

test("模型准入等待期间取消立即结束自身，所有者事务继续且不forward", async () => {
  let release!: () => void;
  const publishing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  let forwarded = false;
  const waiting = awaitModelCommandAdmission(() => publishing, controller.signal).then(() => {
    forwarded = true;
  });
  controller.abort(new Error("fixture cancelled"));
  await assert.rejects(waiting, /fixture cancelled/);
  assert.equal(forwarded, false);
  release();
  await publishing;
});
