/** 将 Step 的实际回合/重试事件接到原 ZCode sink；不另算 UI 的工作中人数。 */
export function createStepActorActivity(sink, instance, isLive) {
  let phase;
  return (event) => {
    if (!isLive()) return;
    if (
      event.type === "turn_start" ||
      (event.type === "message_start" && event.message?.role === "assistant")
    ) {
      if (phase === "executing") return;
      phase = "executing";
      sink.askExecuting(instance);
    } else if (event.type === "auto_retry_start") {
      phase = "waiting";
      const message = String(event.errorMessage ?? "");
      const reason = /429|rate.?limit/i.test(message)
        ? "rate_limited"
        : /overload|503/i.test(message)
          ? "provider_overloaded"
          : "step_retry";
      sink.askWaiting(instance, {
        cause: "backoff",
        reason,
        ...(Number.isInteger(event.attempt) && event.attempt > 0 ? { attempt: event.attempt } : {}),
        ...(Number.isFinite(event.delayMs) && event.delayMs >= 0 ? { delayMs: event.delayMs } : {}),
      });
    }
  };
}
