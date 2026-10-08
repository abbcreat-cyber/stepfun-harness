/** abort 的 ACK 只表示收到请求；工具结果与原生历史完整保存必须以真实终态为准。 */
export function abortUntilSettled(client, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      client.child?.removeListener("exit", exit);
      if (error) reject(error);
      else resolve();
    };
    const exit = () => finish(new Error("子会话在取消收尾前退出"));
    const unsubscribe = client.onEvent(event => {
      if (event.type === "agent_settled") finish();
    });
    const timer = setTimeout(() => finish(new Error("子会话取消收尾超时")), timeoutMs);
    client.child?.once("exit", exit);
    Promise.resolve().then(async () => {
      const state = await client.getState();
      if (settled) return;
      if (!state.isStreaming) finish();
      else await client.abort();
    }).catch(finish);
  });
}

/** 先订阅再发送；取消、进程退出和发送失败都必须释放监听器与计时器。 */
export function promptUntilSettled(client, message, signal, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("工作流已取消"));
      return;
    }
    const events = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      client.child?.removeListener("exit", exit);
      if (error) reject(error);
      else resolve(events);
    };
    const abort = () => finish(new Error("工作流已取消"));
    const exit = () => finish(new Error("Step 子任务进程已退出"));
    const unsubscribe = client.onEvent((event) => {
      events.push(event);
      if (event.type === "agent_settled") finish();
    });
    const timer = setTimeout(() => finish(new Error("Step 子任务等待超时")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    client.child?.once("exit", exit);
    Promise.resolve()
      .then(() => {
        if (!settled) return client.prompt(message, { timeoutMs });
      })
      .catch(finish);
  });
}
