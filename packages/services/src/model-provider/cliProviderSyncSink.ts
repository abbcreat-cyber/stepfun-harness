export interface StepCliProviderSyncSink<TSnapshot> {
  sync(snapshot: TSnapshot): Promise<void>;
  wait(): Promise<void>;
}

/** 唯一宿主写入队列：完整快照串行发布，快速保存只保留最新待处理代。 */
export function createStepCliProviderSyncSink<TSnapshot>(
  writeSnapshot: (snapshot: TSnapshot) => Promise<void>,
  options?: { readonly getRevision: (snapshot: TSnapshot) => number },
): StepCliProviderSyncSink<TSnapshot> {
  let requested = 0;
  let newestRevision = -Infinity;
  let pending: { generation: number; snapshot: TSnapshot } | undefined;
  let running: Promise<void> | undefined;
  let lastError: unknown;
  const waiters: Array<{
    generation: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const settle = (generation: number, error?: unknown) => {
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]!;
      if (waiter.generation > generation) continue;
      waiters.splice(index, 1);
      if (error !== undefined) waiter.reject(error);
      else waiter.resolve();
    }
  };
  const drain = async () => {
    while (pending) {
      const job = pending;
      pending = undefined;
      try {
        await writeSnapshot(job.snapshot);
        lastError = undefined;
        // 已有新代时，旧调用也必须等待最新发布，不能让 spawn 越过队列。
        if (!pending) settle(job.generation);
      } catch (error) {
        lastError = error;
        if (!pending) settle(job.generation, error);
      }
    }
  };
  const start = () => {
    if (running) return;
    const task = drain();
    running = task;
    void task.finally(() => {
      if (running === task) running = undefined;
      if (pending) start();
    });
  };
  const wait = async () => {
    while (running || pending) {
      if (!running) start();
      await running;
    }
    if (lastError !== undefined) throw lastError;
  };
  return {
    sync(snapshot) {
      const revision = options?.getRevision(snapshot);
      // refresh 的 Promise 回调可能晚于较新 change 事件恢复；不得把旧 snapshot 排到新代后。
      if (revision !== undefined && revision < newestRevision) return wait();
      if (revision !== undefined) newestRevision = revision;
      const generation = ++requested;
      pending = { generation, snapshot };
      const result = new Promise<void>((resolve, reject) =>
        waiters.push({ generation, resolve, reject }),
      );
      start();
      return result;
    },
    wait,
  };
}
