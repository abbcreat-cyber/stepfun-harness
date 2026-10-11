import test from 'node:test';
import assert from 'node:assert/strict';
import {StepStreamProjection} from '../src/stream-projection.mjs';
import {nativeSearchResultDisplay,nativeSearchResultNotice} from '../src/search-result-status.mjs';
import {httpFixture,projectedClient} from './provider-wire-fixtures.mjs';
import {writeFile} from 'node:fs/promises';
import {toolOutputSchema} from '@zcode/shared/zcode-protocol-v4';

test('原生受限搜索的完整性事实进入行展示，不挤占按需读取引用',()=>{
 const rows=[],p=new StepStreamProjection(rows,'t','m');
 p.handle({type:'tool_execution_end',toolCallId:'s',toolName:'search_files',isError:false,result:{content:[{type:'text',text:'a.txt:1: MATCH'}],details:{matches:1,truncated:true,timedOut:false,matchLimitReached:1}}});
 assert.equal(rows[0].output.text,'a.txt:1: MATCH');assert.equal(rows[0].output.display?.kind,'search_result');
 assert.equal(rows[0].output.display.returnedCount,1);assert.equal(rows[0].output.display.truncated,true);assert.equal(rows[0].output.truncated,undefined);
 assert.equal(toolOutputSchema.parse(rows[0].output).display.truncated,true);
});

test('零匹配、超时、原生裁剪和不可信字段不混淆',()=>{
 assert.deepEqual(nativeSearchResultDisplay('search_files',{details:{matches:0,truncated:false,timedOut:false}}),{kind:'search_result',returnedCount:0,truncated:false,timedOut:false});
 assert.equal(nativeSearchResultDisplay('search_files',{details:{timedOut:true,matches:0}}).timedOut,true);
 assert.equal(nativeSearchResultDisplay('list_directory',{details:{returnedEntries:2,stepTruncated:true}}).truncated,true);
 assert.equal(nativeSearchResultDisplay('other',{details:{truncated:true}}),null);
 assert.equal(nativeSearchResultDisplay('search_files',{details:{matches:'10',truncated:'true'}}),null);
 assert.equal(nativeSearchResultDisplay('search_files',{details:{matches:1,truncated:false}}).truncated,false);
});
test('模型说明保留原文，正常结果不追加，重复事件不叠加',()=>{
 const event={toolName:'search_files',content:[{type:'text',text:'hit'}],details:{truncated:true}};
 const notice=nativeSearchResultNotice(event);assert.equal(notice.content[0].text,'hit');assert.match(notice.content[1].text,/partial, not exhaustive/);
 assert.equal(nativeSearchResultNotice({...event,content:notice.content}),undefined);
 assert.equal(nativeSearchResultNotice({...event,isError:true}),undefined);
 assert.equal(nativeSearchResultNotice({...event,details:{matches:0,truncated:false}}),undefined);
});
test('真实底座受限搜索经扩展后把限制说明传给模型并保留元数据',{skip:!process.env.STEP_TEST_CLI,timeout:30000},async()=>{
 const h=await httpFixture('openai-chat-completions'),f=await projectedClient('openai-chat-completions',h.baseUrl);
 f.client.options.env.STEPCODE_TASK_MODE='desktop';f.client.options.env.STEPCODE_STORAGE_ROOT_DIR=f.root+'/state';
 f.client.options.env.STEP_DISABLE_CRON='1';
 const path=f.root+'/needle.txt';await writeFile(path,'MATCH_FIXED one\nMATCH_FIXED two\n');
 try{
  h.set({kind:'tool',name:'search_files',args:{path,pattern:'MATCH_FIXED',max_results:1},text:'done'});
  await f.client.start();await f.client.setModel(f.providerId,f.modelId);const events=await f.client.promptAndWait('Run the bounded local search.',{timeoutMs:18000});
  const result=events.find(e=>e.type==='tool_execution_end'&&e.toolName==='search_files')?.result;
  assert.equal(result.details.truncated,true);assert.match(JSON.stringify(result.content),/partial, not exhaustive/);
  assert.ok(h.requests.some(r=>r.body.messages.some(m=>m.role==='tool'&&JSON.stringify(m.content).includes('partial, not exhaustive'))));
 }finally{await f.client.stop();await h.close()}
});
