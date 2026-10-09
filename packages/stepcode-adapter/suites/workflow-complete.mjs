import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { StepWorkflowService } from "../src/workflow/service.mjs";
import { httpFixture, projectedClient } from "./provider-wire-fixtures.mjs";
import { isBarePluginRequest } from "../src/desktop-plugin-context.mjs";
import taskContracts from "../src/extensions/desktop-task-contracts.mjs";
import { existsSync } from "node:fs";

test("real Step blocks a mistaken disk-search command for bare PDF plugin selection", { skip: !process.env.STEP_TEST_CLI, timeout: 30000 }, async t => {
  const f=await httpFixture("openai-chat-completions");
  const p=await projectedClient("openai-chat-completions",f.baseUrl);
  t.after(async()=>{await p.client.stop();await f.close();await rm(p.root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await mkdir(join(p.root,"plugins/pdf/skills/pdf"),{recursive:true});
  await writeFile(join(p.root,"plugins/pdf/step.plugin.json"),JSON.stringify({id:"pdf",stepOfficial:true,skills:["skills"]}));
  await writeFile(join(p.root,"plugins/pdf/skills/pdf/SKILL.md"),"---\nname: pdf-test\ndescription: PDF tools\n---\nPDF_NATIVE_BODY");
  Object.assign(p.client.options.env,{STEPCODE_TASK_MODE:"desktop",STEP_DISABLE_CRON:"1",STEPCODE_STORAGE_ROOT_DIR:p.root});
  const marker=join(p.root,"must-not-execute.txt");
  f.set({kind:"tool",name:"run_command",args:{command:`node -e 'require("fs").writeFileSync(${JSON.stringify(marker)},"BAD")'`,timeout_ms:120000},text:"请提供要处理的 PDF 或具体任务。"});
  await p.client.start();await p.client.setModel(p.providerId,p.modelId);
  await p.client.promptAndWait("[@PDF](plugin://pdf@zcode-plugins-official) 打开它");
  assert.equal(existsSync(marker),false);
  assert.equal(f.requests.length,2);
  assert.ok(f.requests[1].body.messages.some(m=>m.role==="tool"&&JSON.stringify(m).includes("不要猜测文件或扫描磁盘")));
  assert.ok(f.requests[0].body.messages.some(m=>m.role==="user"&&JSON.stringify(m).includes("PDF_NATIVE_BODY")));
});
import { createWorkflowBridge } from "../src/workflow/bridge.mjs";
import { makeConversationSnapshot } from "../src/wire-shapes.mjs";
const { conversationSnapshotSchema } = await import("@zcode/shared/zcode-protocol-v4");

test("snippet MCP admission reaches the desktop permission contract and denies without execution", async () => {
  const root = await mkdtemp("D:/Temp/workflow-approval-");
  const input = { code: 'return await world.run("node",["-e","console.log(123)"]);' };
  const rows = [
    {
      rowId: 1,
      kind: "toolCall",
      toolCallId: "snippet-call",
      toolName: "step_workflows__step_workflows__EvalWorkflowSnippet",
      status: "running",
      input,
    },
  ];
  const bridge = createWorkflowBridge({
    root,
    command: [],
    session: () => ({
      workspace: { workspacePath: root },
      modelSelection: { providerId: "fixture", modelId: "fixture" },
    }),
    rows: () => rows,
    changed() {},
    completed() {},
  });
  try {
    const pending = bridge.request(
      { method: "EvalWorkflowSnippet", params: input },
      { sessionId: "owner" },
    );
    let item;
    for (let i = 0; i < 100; i++) {
      item = bridge.snapshot("owner").pendingInteractions[0];
      if (item) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(item?.payload.toolName, "EvalWorkflowSnippet");
    conversationSnapshotSchema.parse(
      makeConversationSnapshot({
        sessionId: "owner",
        logEpoch: "test",
        seq: 1,
        revision: 1,
        ...bridge.snapshot("owner"),
      }),
    );
    bridge.resolve("owner", item.interactionId, { optionId: "deny" });
    assert.equal((await pending).executed, false);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bare plugin activation asks for a target before scanning; concrete files remain usable", async (t) => {
  const root = await mkdtemp("D:/Temp/plugin-target-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "plugins/pdf/skills/pdf"), { recursive: true });
  await writeFile(
    join(root, "plugins/pdf/step.plugin.json"),
    JSON.stringify({ id: "pdf", stepOfficial: true, skills: ["skills"] }),
  );
  const path = join(root, "plugins/pdf/skills/pdf/SKILL.md");
  await writeFile(path, "PDF_SKILL_BODY");
  const old = {
    STEPCODE_TASK_MODE: process.env.STEPCODE_TASK_MODE,
    STEPCODE_STORAGE_ROOT_DIR: process.env.STEPCODE_STORAGE_ROOT_DIR,
  };
  Object.assign(process.env, { STEPCODE_TASK_MODE: "desktop", STEPCODE_STORAGE_ROOT_DIR: root });
  t.after(() => {
    for (const [k, v] of Object.entries(old))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const handlers = new Map();
  taskContracts({
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
  });
  const hook = handlers.get("before_agent_start")[0];
  const result = await hook(
    {
      prompt: "[@PDF](plugin://pdf@zcode-plugins-official) 打开它",
      systemPrompt: "base",
      systemPromptOptions: { skills: [{ name: "pdf", filePath: path }] },
    },
    { cwd: root },
  );
  assert.equal(result.message.display, false);
  assert.match(result.message.content, /PDF_SKILL_BODY/);
  assert.match(result.message.content, /不是文件附件/);
  const guard = handlers.get("tool_call")[0];
  assert.equal(
    (await guard({ toolName: "run_command", input: { command: "scan disk" } })).block,
    true,
  );
  assert.equal(
    isBarePluginRequest("[@PDF](plugin://pdf@zcode-plugins-official) 打开 D:/docs/test.pdf"),
    false,
  );
  assert.equal(
    isBarePluginRequest("[@PDF](plugin://pdf@zcode-plugins-official) 打开它", [{}]),
    false,
  );
  await hook(
    {
      prompt: "[@PDF](plugin://pdf@zcode-plugins-official) 阅读 D:/docs/test.pdf",
      systemPrompt: "base",
      systemPromptOptions: { skills: [] },
    },
    { cwd: root },
  );
  assert.equal(await guard({ toolName: "find_files", input: { pattern: "test.pdf" } }), undefined);
});

test("original snippet sandbox executes, validates, denies commands and leaves no durable runs", async (t) => {
  const root = await mkdtemp("D:/Temp/workflow-snippet-");
  let allow = false,
    confirmations = 0;
  const service = new StepWorkflowService({
    root,
    cwd: root,
    sessionId: "snippet",
    model: { providerId: "fixture", modelId: "fixture" },
    confirm: async () => {
      confirmations++;
      return { approved: allow };
    },
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await writeFile(join(root, "marker.txt"), "LOCAL_SNIPPET_MARKER");
  const result = await service.evalSnippet(
    { code: 'log("测试"); return await files.read("marker.txt");' },
    "read",
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.artifact, /LOCAL_SNIPPET_MARKER/);
  assert.equal(confirmations, 0);
  assert.equal(
    (await service.evalSnippet({ code: 'return agent("不允许");' }, "invalid")).ok,
    false,
  );
  const code = 'return await world.run("node",["-e","console.log(123)"]);';
  assert.equal((await service.evalSnippet({ code }, "denied")).status, "denied");
  allow = true;
  assert.equal((await service.evalSnippet({ code }, "allowed")).artifact.stdout.trim(), "123");
  assert.equal(
    (await service.evalSnippet({ code: "while(true) {}", timeoutMs: 100 }, "timeout")).ok,
    false,
  );
  assert.equal(service.list().length, 0);
});

test(
  "real Step amendments reuse finished asks and seed actor context, questions unblock exactly once",
  { skip: !process.env.STEP_TEST_CLI, timeout: 90000 },
  async (t) => {
    const fixture = await httpFixture("openai-chat-completions");
    t.after(() => fixture.close());
    const p = await projectedClient("openai-chat-completions", fixture.baseUrl);
    const root = p.root;
    await mkdir(join(root, "workflows"));
    const service = new StepWorkflowService({
      root: join(p.root, "workflows"),
      cwd: p.root,
      sessionId: "complete",
      model: { providerId: p.providerId, modelId: p.modelId },
      command: [process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions"],
      getClientEnvironment: async () => p.env,
      confirm: async () => ({ approved: true }),
      onQuestion: (q) =>
        setImmediate(() => {
          const r = service.resolveQuestion({ question_id: q.qid, answer: "目标已确认" });
          assert.equal(r.ok, true);
          assert.equal(
            service.resolveQuestion({ question_id: q.qid, answer: "重复" }).reason,
            "already_resolved",
          );
        }),
    });
    t.after(async () => {
      await service.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await service.guide();
    fixture.set({ kind: "text", text: '{"summary":"FIRST_NATIVE_RESULT"}' });
    const script =
      'phase("验证"); const a=agent("检查员",{system:"Return JSON"}); const first=await a.ask<{summary:string}>("FIRST_ASK"); return first;';
    const first = await service.create({ script }, "first");
    await service.active.get(first.runId)?.promise;
    assert.equal(service.detail(first.runId).run.status, "completed");
    const count = fixture.requests.length;
    const revised = script.replace(
      "return first;",
      'const next=await a.ask<{summary:string}>("SECOND_ASK"); return {first,next};',
    );
    const second = await service.amend({ run_id: first.runId, script: revised }, "amend");
    assert.equal(second.ok, true, JSON.stringify(second));
    await service.active.get(second.runId)?.promise;
    const detail = service.detail(second.runId);
    assert.equal(detail.run.status, "completed", JSON.stringify(detail.run));
    assert.equal(fixture.requests.length, count + 1, "finished ask reused instead of billed again");
    assert.match(
      JSON.stringify(fixture.requests.at(-1).body.messages),
      /FIRST_NATIVE_RESULT/,
      "live changed ask gets native predecessor history",
    );
    assert.equal(detail.run.resumedFrom, first.runId);
    fixture.set({
      kind: "tool",
      name: "clarify_user",
      args: { question: "请选择目标", allow_freeform: true },
      text: '{"summary":"QUESTION_RESOLVED"}',
    });
    const qrun = await service.create(
      {
        script:
          'phase("提问"); const a=agent("提问员",{system:"Return JSON"}); return await a.ask<{summary:string}>("ASK_QUESTION");',
      },
      "question",
    );
    await service.active.get(qrun.runId)?.promise;
    assert.equal(service.detail(qrun.runId).run.status, "completed");
    assert.ok(fixture.requests.some((x) => JSON.stringify(x.body.messages).includes("目标已确认")));
    assert.equal(service.questions.list(qrun.runId).length, 0);
    assert.equal(
      service.resolveQuestion({ question_id: "unknown", answer: "x" }).reason,
      "unknown_question",
    );
  },
);
