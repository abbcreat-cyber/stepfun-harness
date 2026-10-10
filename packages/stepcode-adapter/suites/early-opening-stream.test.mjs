import test from "node:test";
import assert from "node:assert/strict";
import { earlyOpeningStream, openingTaskText } from "../src/early-opening-stream.mjs";
const model = { api: "openai-completions", provider: "fixture", id: "fixture" };
const message = (text, usage = 1) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  usage: { input: usage, output: usage, cost: { total: usage } },
  timestamp: 1,
  ...model,
  model: model.id,
});
function collector(onPush) {
  let resolve;
  const result = new Promise((r) => (resolve = r)),
    events = [];
  return {
    events,
    push(e) {
      events.push(e);
      onPush?.(e);
      if (e.type === "done" || e.type === "error") resolve(e.message ?? e.error);
    },
    result: () => result,
  };
}
const context = {
  systemPrompt: "<desktop_opening_timing>",
  messages: [{ role: "user", content: "画一个svg山水画" }],
};
const main = async function* () {
  yield { type: "start", partial: message("") };
  yield { type: "text_delta", contentIndex: 0, delta: "完成", partial: message("完成") };
  yield { type: "done", reason: "stop", message: message("完成") };
};
test("普通问候、无启用标记和纯图片不额外开场，任务取本轮用户文本", () => {
  assert.equal(
    openingTaskText({ ...context, messages: [{ role: "user", content: "你好" }] }),
    null,
  );
  assert.equal(openingTaskText({ ...context, systemPrompt: "" }), null);
  assert.equal(
    openingTaskText({
      ...context,
      messages: [{ role: "user", content: [{ type: "image", data: "fake" }] }],
    }),
    null,
  );
  assert.equal(openingTaskText(context), "画一个svg山水画");
  assert.equal(openingTaskText({...context,messages:[{role:"user",content:"What is a prefix?"}]}),null);
  assert.equal(openingTaskText({...context,messages:[{role:"user",content:"工作流状态通知：创建成功"}]}),null);
  assert.equal(openingTaskText({...context,messages:[{role:"user",content:"Please optimize this component"}]}),"Please optimize this component");
});
test("开场超时只回退一次，主请求可继续", async () => {
  let calls = 0,
    aborted = false;
  const out = earlyOpeningStream({
    createStream: collector,
    model,
    context,
    options: {},
    timeoutMs: 10,
    startOpening: (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return { result: () => new Promise(() => {}) };
    },
    startMain: () => {
      calls++;
      return main();
    },
  });
  const result = await out.result();
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].text, "完成");
});
for (const stage of ["during-opening", "after-opening"])
  test(`取消 ${stage} 不启动主请求`, async () => {
    const c = new AbortController();
    let calls = 0;
    const out = earlyOpeningStream({
      createStream: () =>
        collector((e) => {
          if (stage === "after-opening" && e.type === "text_end") c.abort();
        }),
      model,
      context,
      options: { signal: c.signal },
      startOpening: () => ({
        result: () =>
          stage === "during-opening"
            ? new Promise(() => {})
            : Promise.resolve(message("我会绘制山水画，先确定远山和湖面的布局。")),
      }),
      startMain: () => {
        calls++;
        return main();
      },
    });
    if (stage === "during-opening") c.abort();
    const result = await out.result();
    assert.equal(result.stopReason, "aborted");
    assert.equal(calls, 0);
  });
test("开场失败或套话不伪造进度，实际用量仍累加", async () => {
  const out = earlyOpeningStream({
    createStream: collector,
    model,
    context,
    options: {},
    startOpening: () => ({ result: async () => message("好的，请稍等。", 2) }),
    startMain: main,
  });
  const result = await out.result();
  assert.equal(result.content.length, 1);
  assert.equal(result.usage.input, 3);
  assert.equal(result.usage.cost.total, 3);
});
test("有效开场先发布，主内容索引平移且参数原样保留", async () => {
  let mainContext;
  const out = earlyOpeningStream({
    createStream: collector,
    model,
    context,
    options: {},
    startOpening: () => ({
      result: async () => message("我会绘制山水画，先确定远山和湖面的布局。", 2),
    }),
    startMain: (ctx) => {
      mainContext = ctx;
      return main();
    },
  });
  const result = await out.result();
  assert.equal(out.events.filter((e) => e.type === "start").length, 1);
  assert.equal(
    out.events.find((e) => e.type === "text_delta" && e.delta === "完成").contentIndex,
    1,
  );
  assert.equal(result.content.length, 2);
  assert.equal(result.usage.input, 3);
  assert.deepEqual(mainContext.messages, context.messages);
});
