import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { attachJsonlLineReader } from "./jsonl.mjs";
import { isWorkflowActorReadMethod } from "./workflow/catalog.mjs";

/**
 * worker 身份标记的 env 键：运行时拼接（同 src/bridge/logging.mjs 的先例 + spec §8）。
 * 宿主对源码中 STECODE_* 前缀的连续字面量存在间歇清洗（R5 评审 3/3 复现）——字面量
 * 写入命中清洗时 worker 侧读不到该标记。拼接键不受影响；worker 侧
 * bin/zcode-bridge-session.mjs 以同款拼接键读取，语义仍是同名环境变量。
 */
const SESSION_WORKER_ENV_KEY = ["STEPCODE", "SESSION", "WORKER"].join("_");

/** 只路由协议；每个会话的运行、序号和持久化仍由其唯一工作进程拥有。 */
const WORKSPACE = Symbol("workspace");
export class SessionRouter {
  constructor(options) {
    this.options = options;
    this.workers = new Map();
    this.subscriptions = new Map();
    this.hostRequests = new Map();
    this.creates = new Map();
    this.commandReplies = new Map();
    this.actorOwners = new Map();
    /** per-connection 流控（v4/connection/flow）：connectionId → "saturated"|"drained"|"closed"。 */
    this.connectionFlowStates = new Map();
    this.ordinal = 0;
    this.lastSessionId = null;
    this.closed = false;
    this.reaper = setInterval(() => this.releaseIdle(), 30000);
    this.reaper.unref();
  }
  worker(key) {
    let worker = this.workers.get(key);
    if (worker) return worker;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../bin/zcode-bridge-session.mjs", import.meta.url)),
        "--session-worker",
        ...this.options.args,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, [SESSION_WORKER_ENV_KEY]: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    worker = {
      key,
      child,
      pending: new Map(),
      initialized: false,
      active: false,
      background: false,
      subscriptions: new Set(),
      subscriptionDetails: new Map(),
      lastUsed: Date.now(),
      exit: null,
      indexRefreshPending: false,
      indexRefreshDirty: false,
      indexRefreshClosed: false,
    };
    this.workers.set(key, worker);
    child.stdin.on("error", () => {});
    worker.exit = new Promise((resolve) =>
      child.once("close", () => {
        worker.indexRefreshClosed = true;
        if (this.workers.get(key) === worker) this.workers.delete(key);
        for (const pending of worker.pending.values())
          pending.finish({ error: { code: -32000, message: "会话执行进程已退出，请重试" } });
        worker.pending.clear();
        resolve();
      }),
    );
    child.on("error", (error) => {
      worker.indexRefreshClosed = true;
      for (const pending of worker.pending.values())
        pending.finish({ error: { code: -32000, message: error.message } });
      worker.pending.clear();
    });
    child.stderr.on("data", (chunk) => this.options.diagnostic?.(chunk.toString()));
    attachJsonlLineReader(child.stdout, (line) => {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (frame.method === "bridge/sessionIndexChanged") {
        const admin = this.workers.get(WORKSPACE);
        if (admin) this.refreshSessionIndex(admin);
        return;
      }
      if (frame.method === "session/event") {
        if (frame.params?.type === "turn.started") worker.active = true;
        if (frame.params?.type === "turn.completed") worker.active = false;
      }
      const snapshot = frame.params?.frame?.payload?.snapshot;
      if (snapshot) this.rememberActorOwners(worker, snapshot);
      if (snapshot?.backgroundWorks && snapshot.sessionId === worker.key)
        worker.background = snapshot.backgroundWorks.some((w) => w.status === "running");
      if (frame.method !== undefined) {
        if (frame.id !== undefined) this.hostRequests.set(frame.id, worker);
        // 连接背压（v4/connection/flow，宿主侧声明由 zcodeAgentConnectionScope 下发）：
        // flow 请求经 WORKSPACE worker 落地，而 conversation 帧来自各会话 worker——
        // 真正的 per-connection 投递闸门必须在路由层。saturated/closed 的连接跳过
        // 在线帧（initial/recovery 是订阅/重订的定向应答，不受限）；host 侧 seq gap
        // 检测会触发 resync 重订补齐，不丢事实。
        if (frame.method === "v4/conversation/frame" && frame.params?.deliveryKind === "online") {
          const detail = worker.subscriptionDetails.get(frame.params.subscriptionId);
          const flow = detail ? this.connectionFlowStates.get(detail.connectionId) : null;
          if (flow === "saturated" || flow === "closed") return;
        }
        this.options.write(frame);
        return;
      }
      const pending = worker.pending.get(frame.id);
      if (!pending) return;
      worker.pending.delete(frame.id);
      const sub = frame.result?.ack?.subscriptionId;
      if (sub) {
        if (pending.method === "v4/conversation/subscribe")
          for (const [oldId, detail] of worker.subscriptionDetails) {
            if (
              detail.topic === pending.params.topic &&
              detail.connectionId === pending.params.connectionId
            ) {
              worker.subscriptions.delete(oldId);
              worker.subscriptionDetails.delete(oldId);
              this.subscriptions.delete(oldId);
            }
          }
        if(pending.method === "v4/conversation/subscribe")worker.subscriptionDetails.set(sub, {
          topic: pending.params.topic,
          connectionId: pending.params.connectionId,
        });
        this.subscriptions.set(sub, worker);
        worker.subscriptions.add(sub);
      }
      if (pending.method === "v4/conversation/unsubscribe" && !frame.error) {
        this.subscriptions.delete(pending.params.subscriptionId);
        const removed = worker.subscriptionDetails.get(pending.params.subscriptionId);
        worker.subscriptions.delete(pending.params.subscriptionId);
        worker.subscriptionDetails.delete(pending.params.subscriptionId);
        // 连接由多个会话 worker 共享；取消成功且所有 worker 均无订阅后才能回收流控状态。
        if (removed && ![...this.workers.values()].some((owner) =>
          [...owner.subscriptionDetails.values()].some((d) => d.connectionId === removed.connectionId))) {
          this.connectionFlowStates.delete(removed.connectionId);
        }
      }
      if (
        !frame.error &&
        (pending.method === "session/create" ||
          (pending.method === "v4/command" && pending.params.type === "createSession"))
      )
        worker.initialized = true;
      // 同步转发 ACK：同一 stdout chunk 紧随其后的 initial frame 不得抢先到达 Host。
      pending.finish(frame);
    });
    return worker;
  }
  send(worker, method, params, finish) {
    worker.lastUsed = Date.now();
    const id = `router-${process.pid}-${++this.ordinal}`;
    worker.pending.set(id, { method, params, finish });
    worker.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  }
  refreshSessionIndex(worker) {
    if (this.closed || worker.indexRefreshClosed || this.workers.get(WORKSPACE) !== worker) return;
    // 多会话突发通知只保留一个在途刷新；完成后补刷期间的新变化，避免漏掉最终状态。
    if (worker.indexRefreshPending) {
      worker.indexRefreshDirty = true;
      return;
    }
    worker.indexRefreshPending = true;
    worker.indexRefreshDirty = false;
    this.send(worker, "bridge/refreshSessionIndex", {}, () => {
      worker.indexRefreshPending = false;
      if (worker.indexRefreshDirty) this.refreshSessionIndex(worker);
    });
  }
  rememberActorOwners(worker, snapshot) {
    if (snapshot.sessionId !== worker.key) return;
    // actor 会话由父工作进程里的 Step 客户端拥有；打开只读 tab 不能另起客户端或被判成未启动。
    for (const run of snapshot.workflowRuns?.runs ?? [])
      for (const actor of run.actors ?? [])
        if (actor.sessionId && actor.sessionId !== worker.key)
          this.actorOwners.set(actor.sessionId, worker.key);
  }
  receive(frame) {
    if (this.closed || !frame || typeof frame !== "object") return;
    if (frame.method === undefined) {
      const worker = this.hostRequests.get(frame.id);
      if (worker) {
        this.hostRequests.delete(frame.id);
        worker.child.stdin.write(`${JSON.stringify(frame)}\n`);
      }
      return;
    }
    if (frame.id === undefined) return;
    try {
      this.route(frame);
    } catch (error) {
      this.options.write({ id: frame.id, error: { code: -32000, message: error.message } });
    }
  }
  route(frame) {
    let method = frame.method,
      params = frame.params ?? {},
      sessionId = params.sessionId;
    // 记录 per-connection 流控状态（v4/connection/flow；请求继续转发给 WORKSPACE
    // worker，其自管订阅同样执行背压）。
    if (method === "v4/connection/flow") {
      const state = params.state;
      if (
        typeof params.connectionId === "string" &&
        params.connectionId &&
        (state === "saturated" || state === "drained" || state === "closed")
      ) {
        this.connectionFlowStates.set(params.connectionId, state);
      }
    }
    if (method === "v4/commands/query") {
      const groups = new Map();
      const results = [];
      for (const command of params.commands ?? []) {
        const cached = this.commandReplies.get(
          `${command.sessionId ?? "null"}#${command.commandId}`,
        )?.answer?.result;
        if (cached) {
          results.push({ key: command, result: cached });
          continue;
        }
        const key = command.sessionId ?? WORKSPACE;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(command);
      }
      if (!groups.size) {
        this.options.write({ id: frame.id, result: { results } });
        return;
      }
      let remaining = groups.size,
        failed = false;
      for (const [key, commands] of groups)
        this.send(this.worker(key), method, { ...params, commands }, (answer) => {
          if (failed) return;
          if (answer.error) {
            failed = true;
            this.options.write({ id: frame.id, error: answer.error });
            return;
          }
          results.push(...answer.result.results);
          if (--remaining === 0) this.options.write({ id: frame.id, result: { results } });
        });
      return;
    }
    if (
      method === "session/create" ||
      (method === "v4/command" && params.type === "createSession")
    ) {
      const identity =
        method === "v4/command" ? `${params.clientId ?? ""}#${params.commandId}` : null;
      sessionId =
        sessionId ||
        (identity ? this.creates.get(identity) : null) ||
        `step-session_${randomUUID()}`;
      if (identity) this.creates.set(identity, sessionId);
      params = { ...params, sessionId };
      this.lastSessionId = sessionId;
    } else if (typeof params.topic === "string" && params.topic.startsWith("conversation/"))
      sessionId = params.topic.slice(13);
    else if ((method.startsWith("session/") || method === "v4/command") && !sessionId)
      sessionId = this.lastSessionId;
    let worker;
    const actorOwner = this.actorOwners.get(sessionId);
    if (actorOwner && !isWorkflowActorReadMethod(method))
      throw new Error("工作流子会话只读，请在父会话控制工作流");
    if (
      ["v4/conversation/unsubscribe", "v4/conversation/resync"].includes(method) &&
      params.subscriptionId &&
      this.subscriptions.has(params.subscriptionId)
    )
      worker = this.subscriptions.get(params.subscriptionId);
    else worker = this.worker(actorOwner || sessionId || WORKSPACE);
    if (
      (method.startsWith("session/") || method === "v4/command") &&
      sessionId &&
      !params.sessionId
    )
      params = { ...params, sessionId };
    let finish = (answer) =>
      this.options.write({
        id: frame.id,
        ...(answer.error ? { error: answer.error } : { result: answer.result }),
      });
    if (method === "v4/command" && typeof params.commandId === "string") {
      const key = `${frame.params?.sessionId ?? "null"}#${params.commandId}`;
      const prior = this.commandReplies.get(key);
      if (prior) {
        if (prior.answer) finish(prior.answer);
        else prior.waiters.push(finish);
        return;
      }
      const pending = { waiters: [finish], answer: null };
      this.commandReplies.set(key, pending);
      finish = (answer) => {
        pending.answer = answer;
        for (const waiter of pending.waiters) waiter(answer);
        pending.waiters = [];
        if (this.commandReplies.size > 4096)
          for (const [oldKey, value] of this.commandReplies) {
            if (value.answer) {
              this.commandReplies.delete(oldKey);
              break;
            }
          }
      };
    }
    this.send(worker, method, params, finish);
  }
  releaseIdle() {
    for (const [key, worker] of this.workers)
      if (
        key !== WORKSPACE &&
        !worker.active &&
        !worker.background &&
        !worker.pending.size &&
        !worker.subscriptions.size &&
        Date.now() - worker.lastUsed > 120000
      ) {
        this.workers.delete(key);
        worker.child.stdin.end();
      }
  }
  async close() {
    this.closed = true;
    clearInterval(this.reaper);
    await Promise.all(
      [...this.workers.values()].map(async (worker) => {
        worker.child.stdin.end();
        const timer = setTimeout(() => worker.child.kill(), 7000);
        try {
          await worker.exit;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }
}
