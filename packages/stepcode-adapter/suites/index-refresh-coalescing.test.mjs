import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SessionRouter } from "../src/session-router.mjs";

function fixture() {
  const original = cp.spawn,
    children = [];
  cp.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.frames = [];
    child.stdin = new PassThrough();
    child.stdin.on("data", (d) => child.frames.push(JSON.parse(d.toString())));
    child.stdin.on("finish", () => child.emit("close"));
    child.kill = () => child.emit("close");
    children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  const output = [];
  const router = new SessionRouter({
    args: [],
    write(frame) {
      output.push(frame);
    },
  });
  router.receive({
    id: "list",
    method: "v4/conversation/subscribe",
    params: { topic: "sessions-index/test" },
  });
  const admin = children[0],
    a = router.worker("a"),
    b = router.worker("b");
  const emit = (child, frame) => child.stdout.write(JSON.stringify(frame) + "\n");
  const refreshes = () => admin.frames.filter((f) => f.method === "bridge/refreshSessionIndex");
  const notify = (worker = a) => emit(worker.child, { method: "bridge/sessionIndexChanged" });
  const ack = (frame, error) =>
    emit(admin, { id: frame.id, ...(error ? { error } : { result: {} }) });
  return {
    router,
    admin,
    a,
    b,
    refreshes,
    notify,
    ack,
    emit,
    output,
    async cleanup() {
      await router.close();
      cp.spawn = original;
      syncBuiltinESMExports();
    },
  };
}

test("100 条跨会话突发通知只产生一个在途刷新及一次补刷，最后变化不丢", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) f.notify(i % 2 ? f.a : f.b);
    assert.equal(f.refreshes().length, 1);
    f.ack(f.refreshes()[0]);
    assert.equal(f.refreshes().length, 2);
    f.notify();
    f.ack(f.refreshes()[1]);
    assert.equal(f.refreshes().length, 3);
    f.ack(f.refreshes()[2]);
    assert.equal(f.refreshes().length, 3);
    f.notify();
    assert.equal(f.refreshes().length, 4);
    f.ack(f.refreshes()[3]);
    assert.equal(f.refreshes().length, 4);
  } finally {
    await f.cleanup();
  }
});

for (const reason of ["close", "error", "replace", "router-close"]) {
  test(`刷新期间 ${reason} 不再向旧 worker 写入`, async () => {
    const f = fixture();
    try {
      f.notify();
      f.notify();
      const first = f.refreshes()[0];
      if (reason === "router-close") await f.router.close();
      else if (reason === "replace") {
        const [key] = [...f.router.workers].find(([, w]) => w.child === f.admin);
        f.router.workers.delete(key);
        f.router.worker(key);
        f.ack(first);
        f.admin.emit("close");
      } else f.admin.emit(reason, reason === "error" ? new Error("test") : undefined);
      f.notify();
      assert.equal(f.refreshes().length, 1);
    } finally {
      await f.cleanup();
    }
  });
}

test("刷新失败不自旋，后续独立通知仍可刷新", async () => {
  const f = fixture();
  try {
    f.notify();
    f.ack(f.refreshes()[0], { message: "test" });
    assert.equal(f.refreshes().length, 1);
    f.notify();
    assert.equal(f.refreshes().length, 2);
    f.ack(f.refreshes()[1]);
  } finally {
    await f.cleanup();
  }
});

for (const state of ["saturated", "closed"]) {
  test(`共享连接 ${state} 在取消一个会话后仍限制其他会话，最后订阅才回收`, async () => {
    const f = fixture();
    const subscribe = (w, id, connectionId) => {
      f.router.receive({
        id: `subscribe-${id}`,
        method: "v4/conversation/subscribe",
        params: { topic: `conversation/${w.key}`, connectionId },
      });
      f.emit(w.child, { id: w.child.frames.at(-1).id, result: { ack: { subscriptionId: id } } });
    };
    const unsubscribe = (w, id, error) => {
      f.router.receive({
        id: `unsubscribe-${id}`,
        method: "v4/conversation/unsubscribe",
        params: { subscriptionId: id },
      });
      f.emit(w.child, {
        id: w.child.frames.at(-1).id,
        ...(error ? { error: { message: "retry" } } : { result: {} }),
      });
    };
    const sendFrame = (id, kind) =>
      f.emit(f.b.child, {
        method: "v4/conversation/frame",
        params: { subscriptionId: id, deliveryKind: kind },
      });
    try {
      subscribe(f.a, "sa", "shared");
      subscribe(f.b, "sb", "shared");
      subscribe(f.b, "other", "separate");
      for (const connectionId of ["shared", "separate"])
        f.router.receive({
          id: `flow-${connectionId}`,
          method: "v4/connection/flow",
          params: { connectionId, state },
        });
      unsubscribe(f.a, "sa");
      assert.equal(f.router.connectionFlowStates.get("shared"), state);
      f.output.length = 0;
      sendFrame("sb", "online");
      sendFrame("other", "online");
      assert.equal(f.output.length, 0);
      sendFrame("sb", "initial");
      sendFrame("sb", "recovery");
      assert.deepEqual(
        f.output.map((x) => x.params.deliveryKind),
        ["initial", "recovery"],
      );
      unsubscribe(f.b, "sb", true);
      assert.equal(f.router.subscriptions.get("sb"), f.b);
      assert.equal(f.b.subscriptionDetails.get("sb").connectionId, "shared");
      f.router.receive({
        id: "drain",
        method: "v4/connection/flow",
        params: { connectionId: "shared", state: "drained" },
      });
      f.output.length = 0;
      sendFrame("sb", "online");
      sendFrame("other", "online");
      assert.equal(f.output.length, 1);
      unsubscribe(f.b, "sb");
      assert.equal(f.router.connectionFlowStates.has("shared"), false);
      assert.equal(f.router.connectionFlowStates.get("separate"), state);
      unsubscribe(f.b, "other");
      assert.equal(f.router.connectionFlowStates.has("separate"), false);
    } finally {
      await f.cleanup();
    }
  });
}
