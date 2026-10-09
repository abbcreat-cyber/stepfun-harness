import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {rm} from 'node:fs/promises';
import {projectedClient,protocols,readTool,assistant,messageText} from './provider-wire-fixtures.mjs';

for(const mode of ['missing-required','malformed-json','valid-parallel'])test(`native argument repair: ${mode}`,{skip:!process.env.STEP_TEST_CLI,timeout:30000},async t=>{
 let fixture;const requests=[];
 const chunk=(delta,finish=null)=>({id:'repair-fixture',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:finish}]});
 const server=createServer(async(req,res)=>{
  const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts));requests.push(body);
  const tool=readTool(body,fixture.marker),args=JSON.stringify(tool.args),frames=[];
  if(requests.length===1){
   frames.push(chunk({role:'assistant',reasoning_content:'Read two files.'}));
   for(let i=0;i<2;i++)frames.push(chunk({tool_calls:[{index:i,id:'batch_'+i,type:'function',function:{name:tool.name,arguments:i===0||mode==='valid-parallel'?args:mode==='missing-required'?'{}':args.slice(0,-1)}}]}));
   frames.push(chunk({},'tool_calls'));
  }else if(mode!=='valid-parallel'&&requests.length===2&&JSON.stringify(body.messages).includes('[desktop-tool-arguments-repair]')){
   frames.push(chunk({role:'assistant',content:'我会补齐参数后重新读取。',tool_calls:[{index:0,id:'repaired',type:'function',function:{name:tool.name,arguments:args}}]}),chunk({},'tool_calls'));
  }else frames.push(chunk({role:'assistant',content:'REPAIR_FINISHED'}),chunk({},'stop'));
  res.writeHead(200,{'content-type':'text/event-stream'});for(const f of frames)res.write('data: '+JSON.stringify(f)+'\n\n');res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));fixture=await projectedClient(protocols[0],`http://127.0.0.1:${server.address().port}/v1`);
 t.after(async()=>{await fixture.client.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(fixture.root,{recursive:true,force:true});});
 await fixture.client.start();await fixture.client.setModel(fixture.providerId,fixture.modelId);
 const events=await fixture.client.promptAndWait('Only the result. Read fixture.',{timeoutMs:20000});
 const outputs=events.filter(e=>e.type==='tool_execution_end');
 if(mode==='valid-parallel'){assert.equal(requests.length,2);assert.equal(outputs.filter(e=>!e.isError).length,2);}
 else{
  assert.equal(requests.length,3,'An explicit correction context must reach the next request');
  const beforeRepair=outputs.filter(e=>String(e.toolCallId).startsWith('batch_'));
  assert.equal(beforeRepair.length,2);assert.ok(beforeRepair.every(e=>e.isError),'Never execute a valid sibling from the rejected batch');
  assert.ok(outputs.some(e=>e.toolCallId==='repaired'&&!e.isError));
 }
 assert.equal(messageText(assistant(events)),'REPAIR_FINISHED');
});
