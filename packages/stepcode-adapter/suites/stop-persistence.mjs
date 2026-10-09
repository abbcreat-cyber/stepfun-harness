import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { InputLedger } from "../src/input-admission.mjs";
import { createManagedQueue } from "../src/bridge/managed-queue.mjs";
import { createProjection } from "../src/bridge/projection.mjs";
import { StepStreamProjection } from "../src/stream-projection.mjs";
import { createSnapshotPersistence } from "../src/bridge/snapshot-persistence.mjs";

function setup() {
 const frames = [], writes = [];
 const ctx = {primarySession:{sessionId:"stop-io",modelSelection:{providerId:"mock",modelId:"mock"}},
  ledger:new InputLedger(), turnBusy:true, currentTurnId:"turn", conversationRows:[{kind:"turnHeader",rowId:1,turnId:"turn",state:"running",startedAt:Date.now()}],
  v4Subscriptions:new Map([["conversation/stop-io","sub"]]), conversationSeq:0,stateRevision:0,eventSeq:0,streamingText:"",logEpoch:"test",
  readConversation:()=>null,workflowBridge:{snapshot:()=>({})},sessionStatistics:()=>({usage:()=>({}),handle:()=>false}),
  notify:(method,payload)=>frames.push({method,payload}),persistPrimarySummary(){},broadcastSessionsIndexUpsert(){},scheduleQueueDrain(){},
  persistConversation(){writes.push(structuredClone({rows:ctx.conversationRows,queue:ctx.ledger.serializeQueue()}));},
 };
 const queued=ctx.ledger.begin({commandId:"queued",text:"must stay queued",busy:true});queued.managed=true;ctx.ledger.markQueued(queued.commandId);
 ctx.streamProjection=new StepStreamProjection(ctx.conversationRows,"turn","mock");
 Object.assign(ctx,createProjection(ctx));
 let resolveIdle,aborts=0;
 ctx.client={isRunning:()=>true,waitForIdle:()=>new Promise(r=>{resolveIdle=r;}),abort:async()=>{
  aborts++;assert.equal(ctx.ledger.frozen,true);
  ctx.projectStepEvent({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"command cancelled"}});
  ctx.projectStepEvent({type:"agent_settled"});resolveIdle();
 }};
 Object.assign(ctx,createManagedQueue(ctx));
 const last=()=>frames.filter(f=>f.payload?.frame?.payload?.snapshot).at(-1)?.payload.frame.payload.snapshot;
 return {ctx,writes,last,aborts:()=>aborts};
}

test("stop: transient snapshot IO failure cannot block abort or terminal frame; retries save current state",async()=>{
 const {ctx,writes,last,aborts}=setup();let failures=2;const save=ctx.persistConversation;
 ctx.persistConversation=()=>{if(failures-->0)throw Object.assign(Error("rename locked"),{code:"EPERM"});save();};
 await ctx.stopCurrentTurn();
 assert.equal(aborts(),1);assert.equal(last().control.canStop,false);
 assert.equal(last().rows.window[0].state,"completedInterrupted");
 assert.equal(last().queue.autoDrain,false);assert.equal(last().queue.items.length,1);
 ctx.conversationRows.push({kind:"assistantText",rowId:2,turnId:"turn",text:"latest",state:"complete"});
 await delay(180);assert.equal(writes.at(-1).rows.at(-1).text,"latest");
});

test("stop: permanent file lock has bounded retries and does not stop live delivery",async()=>{
 const {ctx,last,aborts}=setup();let attempts=0;
 ctx.persistConversation=()=>{attempts++;throw Object.assign(Error("rename locked"),{code:"EPERM"});};
 await ctx.stopCurrentTurn();assert.equal(aborts(),1);assert.equal(last().control.canStop,false);
 await delay(1000);const exhausted=attempts;await delay(100);assert.equal(attempts,exhausted);assert.ok(attempts<=8);
});

test("stop: abort errors remain errors",async()=>{
 const {ctx}=setup();ctx.turnBusy=false;ctx.client.abort=async()=>{throw Error("abort transport failed");};
 await assert.rejects(ctx.stopCurrentTurn(),/abort transport failed/);
});

test("stop: workflow cancellation's summary write cannot prevent native abort",async()=>{
 const {ctx,last,aborts}=setup();
 ctx.workflowBridge.cancelPending=()=>{assert.equal(aborts(),1);throw Object.assign(Error("summary rename locked"),{code:"EPERM"});};
 await ctx.stopCurrentTurn();assert.equal(aborts(),1);assert.equal(last().control.canStop,false);
 assert.equal(last().rows.window[0].state,"completedInterrupted");
});

test("snapshot retry: changed owner is never written by the old retry",async()=>{
 let attempts=0;const ctx={primarySession:{sessionId:"before"},persistConversation(){attempts++;throw Object.assign(Error("locked"),{code:"EPERM"});}};
 const save=createSnapshotPersistence(ctx);save();ctx.primarySession={sessionId:"after"};
 await delay(100);assert.equal(attempts,1);
});

test("snapshot retry: non-transient IO does not loop, programming errors are not swallowed",async()=>{
 let attempts=0;const ctx={primarySession:{sessionId:"full"},persistConversation(){attempts++;throw Object.assign(Error("disk full"),{code:"ENOSPC"});}};
 const save=createSnapshotPersistence(ctx);save();await delay(100);assert.equal(attempts,1);
 ctx.persistConversation=()=>{throw new TypeError("bad serializer");};assert.throws(save,/bad serializer/);
});
