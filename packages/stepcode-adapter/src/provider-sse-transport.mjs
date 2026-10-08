/** 只规范 SSE 换行字节；不解释事件/JSON，也不改动 UTF8 序列。 */
export function normalizeSseResponse(response) {
  if (
    !response.body ||
    !/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "")
  )
    return response;
  const reader = response.body.getReader();
  let pendingCr = false,
    cancelled = false;
  const body = new ReadableStream(
    {
      async pull(controller) {
        try {
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (done) {
              if (pendingCr) controller.enqueue(new Uint8Array([10]));
              controller.close();
              reader.releaseLock();
              return;
            }
            const bytes = [];
            for (const byte of value) {
              if (pendingCr) {
                bytes.push(10);
                pendingCr = false;
                if (byte === 10) continue;
              }
              if (byte === 13) pendingCr = true;
              else bytes.push(byte);
            }
            if (bytes.length) {
              controller.enqueue(new Uint8Array(bytes));
              return;
            }
          }
        } catch (error) {
          if (!cancelled) {
            reader.releaseLock();
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        await reader.cancel(reason);
        reader.releaseLock();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
