import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {StepWorkflowService} from '../src/workflow/service.mjs';
import {amendWorkflowSettings} from '../src/bridge/workflow-settings.mjs';
const {commandAckSchema}=await import('@zcode/shared/zcode-protocol-v4');

async function fixture(t){
 const root=await mkdtemp('D:/Temp/workflow-settings-');await mkdir(root+'/cwd');
 const seen=[];const service=new StepWorkflowService({root,sessionId:'owner',cwd:root+'/cwd',model:{providerId:'parent',modelId:'model',options:{reasoningLevel:'enabled'}},command:[],confirm:async()=>({approved:true}),validateModelSelection:async selection=>{seen.push(selection);if(selection.providerId==='missing')throw Error('Model not found');}});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});return{service,seen};
}
test('workflow accepts independent provider/model/reasoning and preserves parent model',async t=>{
 const {service,seen}=await fixture(t);const prepared=await service.prepare({script:'return 1;',subagent_model:'alternate/model$high'});
 assert.equal(prepared.ok,true);assert.deepEqual(prepared.model,{providerId:'alternate',modelId:'model',options:{reasoningLevel:'high'}});
 assert.equal(service.options.model.providerId,'parent');assert.equal(seen.length,1);
});
test('workflow rejects an unavailable requested model before launching',async t=>{
 const {service}=await fixture(t);await assert.rejects(service.prepare({script:'return 1;',subagent_model:'missing/model'}),/Model not found/);assert.equal(service.active.size,0);
});

test('GUI Apply creates successor with selected model; bad selection cannot stop predecessor',async t=>{
 const {service}=await fixture(t);let approvals=0;service.options.confirm=async()=>{approvals++;return{approved:true};};await service.guide();
 const run=await service.create({script:'await world.run("node", ["-e", "setTimeout(()=>console.log(1),1500)"]); return 1;'},'created');
 assert.equal(run.ok,true);
 let row=0;const ctx={primarySession:{sessionId:'owner'},workflowBridge:{service:async()=>service},conversationRows:[],nextRowId:()=>++row,persistConversation(){},broadcastConversationSnapshot(){}};
 const bad=await amendWorkflowSettings(ctx,{commandId:'bad',sessionId:'owner',payload:{workId:run.runId,subagentModel:'missing/model'}},1);
 assert.equal(bad.status,'rejected');assert.equal(service.active.has(run.runId),true);assert.equal(approvals,1);
 const noop=await amendWorkflowSettings(ctx,{commandId:'same',sessionId:'owner',payload:{workId:run.runId,subagentModel:'parent/model$enabled',maxConcurrency:2}},1);
 assert.equal(noop.reasonCode,'fault.command.workflowRunSettingsRejected.unchanged');assert.equal(service.active.has(run.runId),true);
 const ack=await amendWorkflowSettings(ctx,{commandId:'good',sessionId:'owner',payload:{workId:run.runId,subagentModel:'alternate/model$high',maxConcurrency:1}},2);
 commandAckSchema.parse(ack);assert.equal(ack.status,'accepted');assert.notEqual(ack.result.runId,run.runId);assert.equal(approvals,1,'GUI Apply does not open another permission dialog');
 assert.equal(service.assertRun(run.runId).status,'stopped');
 assert.equal(service.assertRun(run.runId).stopReason,'superseded');
 const state=service.refresh();const successor=state.runs.find(r=>r.runId===ack.result.runId);
 assert.equal(successor.subagentModel,'alternate/model$high');assert.equal(successor.concurrency.limit,1);
 const events=service.journal.listEvents(ack.result.runId);assert.equal(events.find(x=>x.event.type==='run-launched').event.subagentModel,'alternate/model$high');
 assert.equal(service.options.model.providerId,'parent');assert.equal(ctx.conversationRows.at(-1).toolName,'AmendWorkflow');
});
