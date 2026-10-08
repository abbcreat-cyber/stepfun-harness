/**
 * zcode-bridge 套件（turn 流式/并发/幂等）：v4 终态前输出正文和工具过程（水位连续）、
 * prewarm 草稿态与首次发送发布、双会话并发与 stop 中断、重复 in-flight 命令幂等重放。
 * 从 zcode-bridge.mjs 机械拆分，用例逐字保留。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBridge } from "./zcode-bridge-launch.mjs";

test("bridge：v4 终态前输出正文和工具过程，水位连续", async () => {
 const bridge=launchBridge([], {STEP_MOCK_DELAY_MS:'90'});
 try {
  bridge.send({id:1,method:'session/create',params:{sessionId:'live-stream',workspace:{workspacePath:'C:/tmp/live-stream'}}});
  await bridge.waitFor(f=>f.id===1);
  bridge.send({id:2,method:'v4/conversation/subscribe',params:{topic:'conversation/live-stream',connectionId:'live',clientMode:'desktop-continuous'}});
  await bridge.waitFor(f=>f.id===2);
  bridge.send({id:3,method:'v4/command',params:{commandId:'stream-command',sessionId:'live-stream',type:'sendText',payload:{text:'mock:tool'}}});
  await bridge.waitFor(f=>f.params?.frame?.payload?.deltas?.some(d=>d.op==='row.delta'&&d.path==='text'));
  assert.equal(bridge.frames.some(f=>f.params?.type==='turn.completed'),false);
  await bridge.waitFor(f=>f.params?.frame?.payload?.deltas?.some(d=>d.row?.kind==='toolCall'&&d.row.status==='running'&&d.row.output?.text));
  assert.equal(bridge.frames.some(f=>f.params?.type==='turn.completed'),false);
  await bridge.waitFor(f=>f.params?.type==='turn.completed');
  const frames=bridge.frames.filter(f=>f.params?.topic==='conversation/live-stream');let seq=0;
  for(const f of frames){const inner=f.params.frame;if(inner.payload.kind==='deltas')assert.equal(inner.fromSeq,seq);seq=inner.toSeq;}
  const rows=frames.at(-1).params.frame.payload.snapshot.rows.window;
  assert.deepEqual(rows.filter(r=>r.kind==='assistantText').map(r=>r.text),['Let me run a tool.','Tool finished: mock']);
  assert.equal(rows.filter(r=>r.kind==='toolCall').length,1);
  assert.equal(rows.find(r=>r.kind==='userInput').sourceCommandId,'stream-command');
 } finally {bridge.child.kill();}
});

test("bridge: prewarm is draft, first send publishes only that conversation", async()=>{
 const b=launchBridge();try{
 b.send({id:1,method:'v4/conversation/subscribe',params:{topic:'sessions-index/C:/tmp/draft-check',connectionId:'draft-check',clientMode:'desktop-continuous'}});await b.waitFor(f=>f.id===1);
 b.send({id:2,method:'session/create',params:{sessionId:'prewarm-a',workspace:{workspacePath:'C:/tmp/draft-check'}}});await b.waitFor(f=>f.id===2);
 const first=await b.waitFor(f=>f.params?.frame?.payload?.deltas?.some(d=>d.session?.sessionId==='prewarm-a'));
 assert.equal(first.params.frame.payload.deltas.find(d=>d.session?.sessionId==='prewarm-a').session.phase,'draft');
 b.send({id:3,method:'v4/command',params:{commandId:'first-input',sessionId:'prewarm-a',type:'sendText',payload:{text:'hello',mode:'yolo'}}});await b.waitFor(f=>f.params?.type==='turn.completed');
 await b.waitFor(f=>f.params?.frame?.payload?.deltas?.some(d=>d.session?.sessionId==='prewarm-a'&&d.session.phase!=='draft'));
 const visible=b.frames.flatMap(f=>f.params?.frame?.payload?.deltas??[]).filter(d=>d.session&&d.session.phase!=='draft');assert.ok(visible.length);assert.deepEqual([...new Set(visible.map(d=>d.session.sessionId))],['prewarm-a']);
 b.send({id:4,method:'session/read',params:{sessionId:'prewarm-a'}});assert.equal((await b.waitFor(f=>f.id===4)).result.settings.mode.current,'yolo');
 }finally{b.child.kill();}
});

test("bridge: two conversations run concurrently and stopping A leaves B running", async()=>{
 const b=launchBridge([], {STEP_MOCK_DELAY_MS:'60'});try{
 b.send({id:1,method:'session/create',params:{sessionId:'parallel-a',workspace:{workspacePath:'C:/tmp/parallel'}}});await b.waitFor(f=>f.id===1);
 b.send({id:2,method:'v4/conversation/subscribe',params:{topic:'conversation/parallel-a',connectionId:'a',clientMode:'desktop-continuous'}});await b.waitFor(f=>f.id===2);
 b.send({id:3,method:'v4/command',params:{commandId:'a-send',sessionId:'parallel-a',type:'sendText',payload:{text:'A '.repeat(80)}}});await b.waitFor(f=>f.params?.type==='turn.started'&&f.params.sessionId==='parallel-a');
 b.send({id:4,method:'session/create',params:{sessionId:'parallel-b',workspace:{workspacePath:'C:/tmp/parallel'}}});const created=await b.waitFor(f=>f.id===4);assert.equal(created.error,undefined);
 b.send({id:5,method:'v4/conversation/subscribe',params:{topic:'conversation/parallel-b',connectionId:'b',clientMode:'desktop-continuous'}});await b.waitFor(f=>f.id===5);
 b.send({id:6,method:'v4/command',params:{commandId:'b-send',sessionId:'parallel-b',type:'sendText',payload:{text:'B '.repeat(12)}}});await b.waitFor(f=>f.params?.type==='turn.started'&&f.params.sessionId==='parallel-b');
 b.send({id:7,method:'v4/command',params:{commandId:'a-stop',sessionId:'parallel-a',type:'stop',payload:{}}});await b.waitFor(f=>f.id===7);
 await b.waitFor(f=>f.params?.type==='turn.completed'&&f.params.sessionId==='parallel-b');
 const a=b.frames.filter(f=>f.params?.topic==='conversation/parallel-a'&&f.params.frame.payload.snapshot?.rows?.window?.length).at(-1).params.frame.payload.snapshot;
 const other=b.frames.filter(f=>f.params?.topic==='conversation/parallel-b'&&f.params.frame.payload.snapshot?.rows?.window?.length).at(-1).params.frame.payload.snapshot;
 assert.equal(a.rows.window.find(r=>r.kind==='turnHeader').state,'completedInterrupted');assert.equal(other.rows.window.find(r=>r.kind==='turnHeader').state,'completedSuccess');
 assert.equal(other.rows.window.find(r=>r.kind==='userInput').text,'B '.repeat(12));assert.equal(a.usage.statistics.turns,1);assert.equal(other.usage.statistics.turns,1);
 }finally{b.child.kill();}
});

test('bridge: repeated in-flight create and send replay one admission',async()=>{
 const b=launchBridge();try{
 const create={method:'v4/command',params:{commandId:'repeat-create',sessionId:null,type:'createSession',payload:{}}};b.send({...create,id:1});b.send({...create,id:2});
 const one=await b.waitFor(f=>f.id===1),two=await b.waitFor(f=>f.id===2);assert.deepEqual(one.result,two.result);const sessionId=one.result.result.sessionId;
 b.send({id:3,method:'v4/commands/query',params:{commands:[{sessionId:null,commandId:'repeat-create'}]}});const query=await b.waitFor(f=>f.id===3);assert.equal(query.result.results[0].result.result.sessionId,sessionId);
 const send={method:'v4/command',params:{commandId:'repeat-send',sessionId,type:'sendText',payload:{text:'once'}}};b.send({...send,id:4});b.send({...send,id:5});assert.deepEqual((await b.waitFor(f=>f.id===4)).result,(await b.waitFor(f=>f.id===5)).result);
 await b.waitFor(f=>f.params?.type==='turn.completed');assert.equal(b.frames.filter(f=>f.params?.type==='turn.started').length,1);
 }finally{b.child.kill();}
});
