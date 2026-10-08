import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";
import { httpFixture, projectedClient } from "./provider-wire-fixtures.mjs";
import { writeFile } from "node:fs/promises";

test(
  "real SDK retains existing AGENTS rule without extra reminders and blocks unbounded rule goal",
  { skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for real rule capture" },
  async (t) => {
    const http = await httpFixture("openai-chat-completions");
    const f = await projectedClient("openai-chat-completions", http.baseUrl);
    const existingRule = "EXISTING_USER_RULE_METHOD_ONLY 从第一性原理出发解决问题。";
    await mkdir(join(f.root, "agent"), { recursive: true });
    await writeFile(join(f.root, "agent/AGENTS.md"), existingRule);
    const client = new StepCodeRpcClient({
      command: [
        process.env.STEP_TEST_CLI,
        "--mode",
        "rpc",
        "--no-extensions",
        "--extension",
        fileURLToPath(new URL("../src/first-principles-hook.mjs", import.meta.url)),
        "--extension",
        fileURLToPath(new URL("../src/extensions/desktop-task-contracts.mjs", import.meta.url)),
      ],
      env: { ...f.env, STEPCODE_TASK_MODE: "desktop", STEP_DISABLE_CRON: "1" },
      cwd: f.root,
    });
    t.after(async () => {
      await client.stop();
      await http.close();
      await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await client.start();
    await client.setModel(f.providerId, f.modelId);
    http.set({ kind: "text", text: "NORMAL_REPLY" });
    for (const prompt of ["第一性原理钩子只是普通历史文字", "第二轮测试"]) {
      await client.promptAndWait(prompt);
      const request = http.requests.at(-1);
      assert.equal(
        JSON.stringify(request.body).split(existingRule).length - 1,
        1,
        "SDK retains the existing user rule without duplicate reminder injection",
      );
      assert.ok(request.body.messages.some(message => ["system", "developer"].includes(message.role) && message.content.includes(existingRule)));
      assert.ok(!JSON.stringify(request.body).includes("查找钩子源码"));
      const lastUser = request.body.messages.filter(message => message.role === "user").at(-1).content;
      assert.equal(typeof lastUser === "string" ? lastUser : lastUser.filter(part => part.type === "text").map(part => part.text).join(""), prompt);
    }
    const events = [];
    client.onEvent((event) => events.push(event));
    const before = http.requests.length;
    http.set({
      kind: "tool",
      name: "create_goal",
      args: { objective: "每轮对话从第一性原理出发，这是长期行为约束，不要标记完成" },
    });
    await client.promptAndWait("做每轮规则，不是长期工作目标");
    assert.ok(
      events.some((event) => event.type === "tool_execution_end" && event.isError),
      "unbounded goal was not blocked",
    );
    assert.ok(
      JSON.stringify(http.requests.slice(before)).includes("常驻规则"),
      "actual native tool result did not carry the guard reason",
    );
    assert.ok(
      !events.some((event) => event.type === "goal_change" || event.customType === "step-goal"),
      "no goal should start",
    );
    if (process.env.STEP_WIRE_EVIDENCE_DIR)
      await writeFile(
        join(process.env.STEP_WIRE_EVIDENCE_DIR, "rules-native-evidence.json"),
        JSON.stringify(
          {
            pass: true,
            turns: 2,
            blocked: true,
            requestCount: http.requests.length - before,
            events: events.filter((e) => e.type === "tool_execution_end"),
          },
          null,
          2,
        ),
      );
  },
);
