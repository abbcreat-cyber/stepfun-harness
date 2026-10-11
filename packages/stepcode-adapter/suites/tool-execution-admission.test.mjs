import test from 'node:test';
import assert from 'node:assert/strict';
import {StepStreamProjection} from '../src/stream-projection.mjs';
import {createWorkflowBridge} from '../src/workflow/bridge.mjs';

test('一批工具参数完成不表示已经执行，后续工具在真实开始前保持待调度',()=>{
 const rows=[], p=new StepStreamProjection(rows,'turn','model');
 const tools=['one','two'].map(id=>({type:'toolCall',id,name:'powershell',arguments:{command:`echo ${id}`}}));
 p.handle({type:'message_start',message:{role:'assistant'}});
 for(const [contentIndex,toolCall] of tools.entries())p.handle({type:'message_update',assistantMessageEvent:{type:'toolcall_end',contentIndex,toolCall}});
 p.handle({type:'message_end',message:{role:'assistant',content:tools,stopReason:'toolUse'}});
 assert.deepEqual(rows.map(r=>r.status),['inputStreaming','inputStreaming']);
 assert.equal(rows[1].input.command,'echo two');
 p.handle({type:'tool_execution_start',toolCallId:'one',toolName:'powershell',args:tools[0].arguments});
 assert.equal(rows[0].status,'running');assert.equal(rows[1].status,'inputStreaming');
 rows[0].status='pendingApproval';
 p.handle({type:'agent_settled'});
 assert.deepEqual(rows.map(r=>r.status),['cancelled','cancelled']);
});

test('批量工具预审批通过后仍待调度，直到原生执行开始',async()=>{
 const rows=[],p=new StepStreamProjection(rows,'t','m');
 p.handle({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:'tool-1234',name:'powershell',arguments:{command:'echo one'}}]}});
 const b=createWorkflowBridge({root:'unused',session:()=>({mode:'build'}),rows:()=>rows,changed(){},completed(){}});
 try{
  const waiting=b.permission('s',{method:'confirm',id:'ui',title:'Approve powershell [1234]',message:'Call: tool-1234\nReview'});
  b.resolve('s',b.snapshot('s').pendingInteractions[0].interactionId,{optionId:'allow'});await waiting;
  assert.equal(rows[0].status,'inputStreaming');
  p.handle({type:'tool_execution_start',toolCallId:'tool-1234',toolName:'powershell',args:{command:'echo one'}});
  assert.equal(rows[0].status,'running');
 }finally{await b.close()}
});
