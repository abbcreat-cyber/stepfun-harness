import test from 'node:test';import assert from 'node:assert/strict';import {createWorkflowBridge} from '../src/workflow/bridge.mjs';
import {resolveNativePermissionAction,withApprovalModeArgs,approvalModeSpawnCommands,stepPermissionStatusWarning} from '../src/permission-policy.mjs';

// 原生工具授权夹具：title/message 形状对齐底座真实后缀（isNativeToolPermission 双正则可命中）。
const nativeRequest=(id)=>({method:'confirm',id,title:'Approve run_command [c83dd39a]',message:'Call: chatcmpl-tool-a49f5339c83dd39a\nShell command could not be fully analyzed (shell-configuration); explicit approval is required.'});
const makeBridge=(modeRef)=>createWorkflowBridge({root:'unused',session:()=>({mode:modeRef.value}),rows:()=>[],changed(){},completed(){}});

test('full access approves native tool permissions, build and ordinary questions still prompt',async()=>{
 let mode='yolo';const bridge=createWorkflowBridge({root:'unused',session:()=>({mode}),rows:()=>[],changed(){},completed(){}});
 const request=nativeRequest('r1');
 try {
  const full=bridge.permission('s',request);assert.equal(bridge.snapshot('s').pendingInteractions.length,0);assert.deepEqual(await full,{confirmed:true});
  mode='build';const ask=bridge.permission('s',nativeRequest('r2'));const pending=bridge.snapshot('s').pendingInteractions[0];assert.ok(pending);bridge.resolve('s',pending.interactionId,{optionId:'deny'});assert.deepEqual(await ask,{confirmed:false});
  mode='yolo';const ordinary=bridge.permission('s',{method:'confirm',id:'r3',title:'Choose deployment',message:'Do you want to continue?'});assert.equal(bridge.snapshot('s').pendingInteractions.length,1);bridge.cancelPending('s');await ordinary;
 }finally{await bridge.close();}
});

test('edit behaves field-by-field like build for native permissions (same pending shape, same allow/deny outcomes)',async()=>{
 const shapes={};
 for(const modeValue of ['build','edit']){
  const mode={value:modeValue};const bridge=makeBridge(mode);
  try{
   // 两次都用同一 request id：payload 内嵌 toolCallId=request.id，id 不同会让逐字段
   // 对比混入与本测试无关的差异。
   const allow=bridge.permission('s',nativeRequest('r-same'));
   let pending=bridge.snapshot('s').pendingInteractions[0];
   assert.ok(pending,`${modeValue} 应建立权限弹窗`);
   const{interactionId,createdAt,...rest}=pending;shapes[modeValue]=rest;
   bridge.resolve('s',interactionId,{optionId:'allow'});
   assert.deepEqual(await allow,{confirmed:true});
   const deny=bridge.permission('s',nativeRequest('r2-same'));
   pending=bridge.snapshot('s').pendingInteractions[0];
   bridge.resolve('s',pending.interactionId,{optionId:'deny'});
   assert.deepEqual(await deny,{confirmed:false});
  }finally{await bridge.close();}
 }
 assert.deepEqual(shapes.build,shapes.edit);
});

test('plan denies native tool permissions directly without creating a pending interaction; ordinary business confirms still prompt',async()=>{
 const mode={value:'plan'};const bridge=makeBridge(mode);
 try{
  const denied=bridge.permission('s',nativeRequest('r1'));
  assert.deepEqual(await denied,{confirmed:false});
  assert.equal(bridge.snapshot('s').pendingInteractions.length,0,'plan 拒绝是桥接策略，不应新增弹窗');
  const business=bridge.permission('s',{method:'confirm',id:'r2',title:'Choose deployment',message:'Do you want to continue?'});
  const pending=bridge.snapshot('s').pendingInteractions[0];
  assert.ok(pending,'plan 下普通业务 confirm 仍建 pending 弹窗');
  bridge.resolve('s',pending.interactionId,{optionId:'allow'});
  assert.deepEqual(await business,{confirmed:true});
 }finally{await bridge.close();}
});

test('resolveNativePermissionAction policy table: yolo allow / plan deny / build-edit-unknown ask / non-native always ask',()=>{
 const request=nativeRequest('x');
 assert.equal(resolveNativePermissionAction('yolo',request),'allow');
 assert.equal(resolveNativePermissionAction('plan',request),'deny');
 assert.equal(resolveNativePermissionAction('build',request),'ask');
 assert.equal(resolveNativePermissionAction('edit',request),'ask');
 assert.equal(resolveNativePermissionAction(undefined,request),'ask');
 assert.equal(resolveNativePermissionAction('yolo',{method:'confirm',title:'业务问题',message:'继续吗'}),'ask','非原生工具授权（业务问题）恒弹窗，yolo 不放行');
});

test('withApprovalModeArgs: appends two-token form; exact token or = prefix already present means no double append',()=>{
 assert.deepEqual(withApprovalModeArgs(['node','step.js','--mode','rpc'],'confirm'),['node','step.js','--mode','rpc','--approval-mode','confirm']);
 const exact=['node','step.js','--approval-mode','auto'];
 assert.equal(withApprovalModeArgs(exact,'confirm'),exact);
 const prefixed=['node','step.js','--approval-mode=auto'];
 assert.equal(withApprovalModeArgs(prefixed,'confirm'),prefixed);
 assert.deepEqual(withApprovalModeArgs(['node'],'auto'),['node','--approval-mode','auto']);
 assert.deepEqual(withApprovalModeArgs([],'confirm'),[]);
 assert.equal(withApprovalModeArgs(null,'confirm'),null);
});

test('approvalModeSpawnCommands assembly: main session confirm / workflow actor auto; preset flag leaves both untouched',()=>{
 const base=['node','step.js','--mode','rpc'];
 const assembly=approvalModeSpawnCommands(base);
 assert.deepEqual(assembly.spawnCommand,[...base,'--approval-mode','confirm'],'主会话底座固定 confirm（Mode: Ask）');
 assert.deepEqual(assembly.actorSpawnCommand,[...base,'--approval-mode','auto'],'工作流 actor 底座固定 auto（后台无人值守不回归）');
 const preset=['node','step.js','--approval-mode=strict'];
 const fixed=approvalModeSpawnCommands(preset);
 assert.equal(fixed.spawnCommand,preset,'host 已含档位（= 前缀形态）不二次追加');
 assert.equal(fixed.actorSpawnCommand,preset);
});

test('stepPermissionStatusWarning probe: non-Ask warns, Ask silent, missing frame/other keys silent',()=>{
 const frame=(statusText)=>({type:'extension_ui_request',id:'st-1',method:'setStatus',statusKey:'step-permission',statusText});
 const bypass=stepPermissionStatusWarning(frame('Mode: Bypass'));
 assert.ok(bypass&&bypass.includes('Mode: Bypass'),'非 Ask 档位应产生告警文本');
 assert.ok(stepPermissionStatusWarning(frame('Mode: Read Only')),'strict 档位同样告警');
 assert.equal(stepPermissionStatusWarning(frame('Mode: Ask')),null);
 assert.equal(stepPermissionStatusWarning(frame(undefined)),null,'缺 statusText 视为 cleared，容忍不告警');
 assert.equal(stepPermissionStatusWarning({type:'message_end'}),null,'无 setStatus 帧不告警');
 assert.equal(stepPermissionStatusWarning(undefined),null);
 assert.equal(stepPermissionStatusWarning({...frame('Mode: Bypass'),statusKey:'other'}),null,'非 step-permission 键不告警');
});
