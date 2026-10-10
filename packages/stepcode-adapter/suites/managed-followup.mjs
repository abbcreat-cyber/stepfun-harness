import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBridge } from "./helpers.mjs";
import { InputLedger } from "../src/input-admission.mjs";
import { createManagedQueue } from "../src/bridge/managed-queue.mjs";
import { createSessionLifecycle } from "../src/bridge/session-lifecycle.mjs";
import { createProjection } from "../src/bridge/projection.mjs";
import { mockClient } from "./helpers.mjs";

async function command(b, id, type, payload = {}) {
 b.send({ id, method: "v4/command", params: { commandId: `managed-${id}`, sessionId: "managed", type, payload } });
 const frame = await b.waitFor(f => f.id === id);
 assert.equal(frame.error, undefined, JSON.stringify(frame.error));
 return frame.result;
}
const snapshot = b => b.frames.filter(f => f.params?.frame?.payload?.snapshot?.sessionId === "managed").at(-1)?.params.frame.payload.snapshot;
async function setup(b) {
 await command(b, 1, "createSession", { workspaceId: "ws" });
 b.send({ id: 2, method: "v4/conversation/subscribe", params: { topic: "conversation/managed", connectionId: "managed-connection", clientMode: "desktop-continuous" } });
 await b.waitFor(() => snapshot(b));
 await command(b, 3, "sendText", { text: "原任务" });
 await b.waitFor(() => snapshot(b)?.control.canStop);
}

test("managed: 重复文本按 ID 取消，停止后可编辑和继续，实际只执行保留项", async () => {
 const b = launchBridge([], { STEP_MOCK_DELAY_MS: "160" });
 try {
  await setup(b);
  await command(b, 4, "sendText", { text: "相同文本" });
  const selection = {providerId:"step",modelId:"step-5-preview",options:{reasoningLevel:"enabled"}};
  await command(b, 5, "sendText", { text: "相同文本", modelSelection:selection });
  assert.deepEqual(snapshot(b).queue.items.find(i=>i.queueItemId==="qi_managed-5").modelSelection,selection,"撤回编辑所需完整模型选项必须穿过桥接快照");
  await command(b, 6, "deleteQueueItem", { queueItemId: "qi_managed-4" });
  await command(b, 7, "stop");
  await b.waitFor(() => snapshot(b)?.control.canStop === false);
  assert.deepEqual(snapshot(b).queue.items.map(i => i.queueItemId), ["qi_managed-5"]);
  await command(b, 8, "editQueueItem", { queueItemId: "qi_managed-5", newText: "修改后" });
  await command(b, 9, "setAutoDrain", { autoDrain: true });
  await b.waitFor(() => snapshot(b)?.rows.window.some(r => r.kind === "userInput" && r.text === "修改后"));
  await b.waitFor(() => snapshot(b)?.control.canStop === false && snapshot(b)?.queue.items.length === 0);
  assert.equal(snapshot(b).rows.window.filter(r => r.kind === "userInput" && r.text === "相同文本").length, 0);
 } finally { b.child.kill(); }
});

test("managed: queue_update 不丢 managed 消息，FIFO 执行一次", async () => {
 const b = launchBridge([], { STEP_MOCK_DELAY_MS: "90" });
 try {
  await setup(b);
  await command(b, 4, "sendText", { text: "B" });
  await command(b, 5, "sendText", { text: "C" });
  await b.waitFor(() => snapshot(b)?.rows.window.filter(r => r.kind === "userInput").length === 3, { timeoutMs: 20000 });
  await b.waitFor(() => snapshot(b)?.control.canStop === false && snapshot(b)?.queue.items.length === 0, { timeoutMs: 20000 });
  assert.deepEqual(snapshot(b).rows.window.filter(r => r.kind === "userInput").map(r => r.text), ["原任务", "B", "C"]);
 } finally { b.child.kill(); }
});

test("managed: 停止后的立即发送只执行指定项，其余仍暂停", async () => {
 const b = launchBridge([], { STEP_MOCK_DELAY_MS: "120" });
 try {
  await setup(b);
  await command(b, 4, "sendText", { text: "B" });
  await command(b, 5, "sendText", { text: "C" });
  await command(b, 6, "stop");
  await command(b, 7, "sendQueuedNow", { queueItemId: "qi_managed-5" });
  await b.waitFor(() => snapshot(b)?.rows.window.some(r => r.kind === "userInput" && r.text === "C"));
  await b.waitFor(() => snapshot(b)?.control.canStop === false);
  assert.deepEqual(snapshot(b).queue.items.map(i => i.text), ["B"]);
  assert.equal(snapshot(b).queue.autoDrain, false);
 } finally { b.child.kill(); }
});

test("managed: 重启仍展示未发送队列，显式继续后发送一次", async () => {
 const b = launchBridge([], { STEP_MOCK_DELAY_MS: "120" });
 let next;
 try {
  await setup(b);
  await command(b, 4, "sendText", { text: "重启保留" });
  await command(b, 5, "stop");
  next = launchBridge([], {}, { stateDir: b.stateDir });
  next.send({ id: 20, method: "v4/conversation/subscribe", params: { topic: "conversation/managed", connectionId: "restored", clientMode: "web-remote-replayable" } });
  await next.waitFor(() => snapshot(next)?.queue.items.length === 1);
  assert.equal(snapshot(next).queue.autoDrain, false);
  await command(next, 21, "setAutoDrain", { autoDrain: true });
  await next.waitFor(() => snapshot(next)?.rows.window.some(r => r.kind === "userInput" && r.text === "重启保留"));
  assert.equal(snapshot(next).rows.window.filter(r => r.kind === "userInput" && r.text === "重启保留").length, 1);
 } finally { next?.child.kill(); b.child.kill(); }
});

test("managed: 调度前配置失败保留消息，投递超时禁止重复发送", async () => {
 for (const preflight of [true, false]) {
  const ledger = new InputLedger();
  const entry = ledger.begin({ commandId: "failure", text: "保留", busy: true });
  entry.managed = true; ledger.markQueued(entry.commandId);
  let sent = 0;
  const ctx = { ledger, primarySession: {sessionId:"managed"}, turnBusy:false,
   persistConversation() {}, broadcastConversationSnapshot() {}, ensureClient: async () => {},
   attachmentStore: {prepare: async (_id, _attachments, text) => ({ images: [], text })}, hydrateStatistics: async () => {},
   applyModelSelection: async () => {if(preflight) throw Error("配置失败");},
   preparePrompt: async () => {}, discardPreparedPrompt: async () => {},
   client: {prompt: async () => {sent++; throw Object.assign(Error("timeout"), {stepTimeout:true});}},
  };
  ctx.runWithPreparedClient = async (_options, operation) => {
   if (preflight) throw Error("配置失败");
   ctx.client.getState = async () => ({});
   return operation(ctx.client);
  };
  if(preflight) entry.modelSelection={providerId:"mock",modelId:"missing"};
  Object.assign(ctx, createManagedQueue(ctx));
  await ctx.manageQueue({sessionId:"managed",type:"setAutoDrain",payload:{autoDrain:true}});
  await ctx.runInputOperation(() => {});
  assert.equal(ledger.frozen, true);
  assert.equal(entry.state, preflight ? "queued" : "submitted");
  await ctx.manageQueue({sessionId:"managed",type:"setAutoDrain",payload:{autoDrain:true}});
  await ctx.runInputOperation(() => {});
  assert.equal(sent, preflight ? 0 : 1);
 }
});

test("append: 原生 prompt 的 steer 选项在空闲时直接启动，不能留在池里", async () => {
 const client = mockClient();
 try {
  await client.start();
  const idle = client.waitForIdle(2000);
  await client.prompt("结束边界追加", {streamingBehavior:"steer"});
  await idle;
  assert.ok((await client.getMessages()).some(m=>m.role==="user"),"空闲追加必须直接执行而非滞留原生池");
 } finally { await client.stop(); }
});

for (const order of ["start-before-ack", "start-after-ack", "delivered-before-ack"]) {
 test(`append: 结束与 ACK 边界 ${order} 只归属一次，队列不复活`, async () => {
  const ctx = {ledger:new InputLedger(), primarySession:{sessionId:"boundary",modelSelection:{providerId:"mock",modelId:"mock-mini"}},
   turnBusy:true,currentTurnId:"old-run",conversationRows:[],v4Subscriptions:new Map(),streamingText:"",eventSeq:0,stateRevision:0,
   attachmentStore:{prepare: async (_id, _attachments, text) => ({ images: [], text: `${text}\n附件清单：排队费用.csv` })},ensureClient:async()=>{},hydrateStatistics:async()=>{},
   sessionStatistics:()=>({handle:()=>false}),scheduleQueueDrain(){},notify(){},persistPrimarySummary(){},broadcastSessionsIndexUpsert(){},
  };
  Object.assign(ctx,createProjection(ctx));
  let forwarded;
  ctx.client = {
   steer:async()=>{forwarded="raw-steer";},
   prompt:async(text,options)=>{
    assert.equal(text,"结束边界追加\n附件清单：排队费用.csv");
    forwarded=options.streamingBehavior;
    if(order==="delivered-before-ack") {
     ctx.projectStepEvent({type:"message_start",message:{role:"user",content:[{type:"text",text}]}});
     ctx.projectStepEvent({type:"agent_settled"});
    } else {
     ctx.projectStepEvent({type:"agent_settled"});
     if(order==="start-before-ack")ctx.projectStepEvent({type:"agent_start"});
    }
   },
  };
  ctx.runWithPreparedClient = async (_options, operation) => operation(ctx.client);
  ctx.carryPrompt = async () => {};
  const {admitAndSend}=createSessionLifecycle(ctx);
  await admitAndSend({commandId:"boundary-append",text:"结束边界追加",requestedDelivery:"startNow"});
  assert.equal(forwarded,"steer","必须由原生 prompt 根据真正的 streaming 状态路由");
  if(order==="start-after-ack"){
   assert.equal(ctx.turnBusy,true,"新轮 ACK 到 agent_start 之间保留运行槽，队列不得越过追加输入");
   ctx.projectStepEvent({type:"agent_start"});
  }
  const rows=ctx.conversationRows.filter(r=>r.kind==="userInput");
  assert.equal(rows.length,1,"ACK 与 agent_start 的顺序不应重复追加正文");
  assert.equal(rows[0].text,"结束边界追加","底座附件清单不应污染 UI 正文或破坏插话归属");
  assert.equal(rows[0].turnId,ctx.currentTurnId,"正文必须归属实际消费它的 run");
  assert.equal(ctx.ledger.queueItems().length,0,"已消费追加不能在晚到 ACK 后复活");
  ctx.flushStreamDeltas();
 });
}
