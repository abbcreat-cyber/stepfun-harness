import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowBridge} from '../src/workflow/bridge.mjs';

test('原生审批按完整调用 ID 关联，不能误展示最后一条命令', async()=>{
 const input={command:"$值 = '中文'\n  Write-Output $值\n",timeout:4};
 const rows=[{kind:'toolCall',rowId:'row-a',toolCallId:'call-1111',toolName:'powershell',input},{kind:'toolCall',rowId:'row-b',toolCallId:'call-2222',toolName:'run_command',input:{command:'echo wrong'}}];
 const bridge=createWorkflowBridge({root:'unused',session:()=>({mode:'build'}),rows:()=>rows,changed(){},completed(){}});
 const request={method:'confirm',id:'ui-a',title:'Approve powershell [1111]',message:'Call: call-1111\nReview command'};
 try {
  const waiting=bridge.permission('s',request);const pending=bridge.snapshot('s').pendingInteractions[0];
  assert.equal(pending.anchorRowId,'row-a');assert.equal(pending.payload.toolCallId,'call-1111');
  assert.equal(pending.payload.toolName,'powershell');assert.deepEqual(pending.payload.detail.input,input);
  assert.equal(pending.payload.detail.reason,request.message);
  assert.equal(rows[0].status,'pendingApproval');assert.equal(rows[0].interactionId,pending.interactionId);
  bridge.resolve('s',pending.interactionId,{optionId:'deny'});assert.deepEqual(await waiting,{confirmed:false});
  assert.equal(rows[0].status,'cancelled');assert.equal(rows[0].interactionId,undefined);
 }finally{await bridge.close()}
});

test('原生审批允许恢复运行；取消清理待审批状态且不覆盖新状态',async()=>{
 const row={kind:'toolCall',rowId:'r',toolCallId:'call-1111',toolName:'powershell',input:{command:'echo ok'},status:'running'};
 const bridge=createWorkflowBridge({root:'unused',session:()=>({mode:'build'}),rows:()=>[row],changed(){},completed(){}});
 const req={method:'confirm',id:'u',title:'Approve powershell [1111]',message:'Call: call-1111\nReview'};
 try{
  let waiting=bridge.permission('s',req);let p=bridge.snapshot('s').pendingInteractions[0];bridge.resolve('s',p.interactionId,{optionId:'allow'});assert.deepEqual(await waiting,{confirmed:true});assert.equal(row.status,'running');
  waiting=bridge.permission('s',req);bridge.cancelPending('s');await waiting;assert.equal(row.status,'cancelled');assert.equal(row.interactionId,undefined);
  const abort=new AbortController();waiting=bridge.permission('s',req,abort.signal);row.interactionId='new-interaction';row.status='success';abort.abort();await waiting;assert.equal(row.status,'success');assert.equal(row.interactionId,'new-interaction');
  waiting=bridge.permission('s',req);p=bridge.snapshot('s').pendingInteractions[0];row.interactionId='newer';row.status='success';bridge.resolve('s',p.interactionId,{optionId:'allow'});await waiting;assert.equal(row.status,'success');assert.equal(row.interactionId,'newer');
 }finally{await bridge.close()}
});

test('原生审批无匹配记录时保留原消息，不猜测其它工具参数', async()=>{
 const bridge=createWorkflowBridge({root:'unused',session:()=>({mode:'build'}),rows:()=>[{kind:'toolCall',rowId:'wrong',toolCallId:'call-2222',input:{command:'wrong'}}],changed(){},completed(){}});
 const request={method:'confirm',id:'ui-a',title:'Approve powershell [1111]',message:'Call: call-1111\nReview command'};
 try{const waiting=bridge.permission('s',request);const p=bridge.snapshot('s').pendingInteractions[0];assert.equal(p.anchorRowId,null);assert.equal(p.payload.detail,request.message);bridge.cancelPending('s');await waiting}finally{await bridge.close()}
});
