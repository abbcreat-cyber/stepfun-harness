import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectedClient } from "./provider-wire-fixtures.mjs";
import { prepareProviderRequestOptions } from "../src/provider-request-options.mjs";

for (const mode of ["mapped", "native-binding", "native-unmanaged"])
  test(
    mode === "native-unmanaged"
      ? "未绑定的原生供应商保持直通，不新增开场请求"
      : `${mode} 同一轮次先生成开场再调用工具，索引与用量准确`,
    { skip: !process.env.STEP_TEST_CLI, timeout: 30000 },
    async (t) => {
      const managed = mode === "mapped";
      const requests = [];
      let f;
      const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const b of req) chunks.push(b);
        const body = JSON.parse(Buffer.concat(chunks).toString()),
          i = requests.length;
        requests.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (delta, finish = null, usage) =>
          res.write(
            "data: " +
              JSON.stringify({
                id: "r" + i,
                model: f.modelId,
                choices: [{ index: 0, delta, finish_reason: finish }],
                ...(usage ? { usage } : {}),
              }) +
              "\n\n",
          );
      if (mode === "native-unmanaged") send({role:"assistant",content:"原生直通回复。"});
      else if (i === 0) send({ role: "assistant", content: "我先读取指定文件，核对其中的校验码。" });
        else if (i === 1) {
          send({ role: "assistant", reasoning_content: "fixture reasoning" });
          send({
            tool_calls: [
              {
                index: 0,
                id: "read-marker",
                type: "function",
                function: { name: "read_file", arguments: JSON.stringify({ path: f.marker }) },
              },
            ],
          });
          if (managed)
            send({
              tool_calls: [
                {
                  index: 0,
                  id: "read-marker",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: f.marker }) },
                },
              ],
            });
        } else send({ role: "assistant", content: "校验完成。" });
        send({}, i === 1 ? "tool_calls" : "stop", {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        });
        res.end("data: [DONE]\n\n");
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      f = await projectedClient(
        "openai-chat-completions",
        "http://127.0.0.1:" + server.address().port + "/v1",
        {
          optionSpecs: {
            reasoningLevel: {
              values: ["enabled", "disabled"],
              map: '{"fixture_reasoning":reasoningLevel,"reasoning_effort":null,"thinking":null}',
            },
            maxOutputTokens: {
              max: 2048,
              map: '{"max_completion_tokens":null,"max_tokens":maxOutputTokens}',
            },
          },
        },
      );
      f.client.options.command.push(
        "--extension",
        fileURLToPath(new URL("../src/extensions/desktop-task-contracts.mjs", import.meta.url)),
      );
      Object.assign(f.client.options.env, {
        STEPCODE_TASK_MODE: "desktop",
        STEPCODE_STORAGE_ROOT_DIR: f.root,
        STEP_DISABLE_CRON: "1",
      });
      t.after(async () => {
        await f.client.stop();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        await rm(f.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      });
      if (!managed) {
        if (mode === "native-binding")
          delete f.document.providers[f.providerId].models[0].compat.stepcodeDesktop.optionSpecs;
        else delete f.document.providers[f.providerId].models[0].compat.stepcodeDesktop;
        await writeFile(join(f.root, "models.json"), JSON.stringify(f.document));
      }
      await f.client.start();
      await f.client.setModel(f.providerId, f.modelId);
      if (!managed) await f.client.setThinkingLevel("high");
      await prepareProviderRequestOptions(f.client, {
        providerId: f.providerId,
        modelId: f.modelId,
        options: { reasoningLevel: "enabled" },
      });
    const events = await f.client.promptAndWait("读取指定文件 " + f.marker, { timeoutMs: 20000 });
    if (mode === "native-unmanaged") {
      assert.equal(requests.length,1,"未声明桌面绑定的原生供应商不额外调用");
      assert.equal(requests[0].reasoning_effort,"high");
      return;
    }
      assert.equal(requests.length, 3);
      if (managed) assert.equal(requests[0].fixture_reasoning, "disabled");
      assert.equal(requests[0].max_tokens ?? requests[0].max_completion_tokens, 768);
      assert.ok(!requests[0].tools?.length);
      if (managed) {
        assert.equal(requests[1].fixture_reasoning, "enabled");
        assert.equal(requests[1].max_tokens, 2048);
        assert.equal(requests[2].fixture_reasoning, "enabled");
      } else {
        assert.equal(requests[0].reasoning_effort, undefined);
        assert.equal(requests[1].reasoning_effort, "high");
      }
      const ended = events.filter(
        (e) => e.type === "message_end" && e.message?.role === "assistant",
      );
      assert.equal(ended.length, 2);
      assert.equal(ended[0].message.content[0].text, "我先读取指定文件，核对其中的校验码。");
      assert.equal(ended[0].message.content.find((x) => x.type === "toolCall").name, "read_file");
      assert.equal(ended[0].message.usage.input, 20);
      assert.equal(ended[0].message.usage.output, 4);
      const intro = events.findIndex(
        (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
      );
      const thinking = events.findIndex(
        (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "thinking_delta",
      );
      assert.ok(intro >= 0 && thinking > intro);
      assert.ok(events.some((e) => e.type === "tool_execution_end" && !e.isError));
      assert.equal(
        events.filter((e) => e.type === "tool_execution_start").length,
        1,
        "重复参数快照不能重复执行工具",
      );
    },
  );
