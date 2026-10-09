import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerProviderToolIntegrity} from '../src/provider-tool-integrity.mjs';

test('malformed batch preserves parsed arguments and gives schema errors one explicit correction context',()=>{
 const hooks=new Map();registerProviderToolIntegrity({on:(name,fn)=>hooks.set(name,fn)},()=>true);
 const ctx={model:{api:'openai-completions'}};
 hooks.get('before_agent_start')();
 const valid={type:'toolCall',id:'valid',name:'read_file',arguments:{path:'D:/fixture.txt'}};
 const invalid={type:'toolCall',id:'invalid',name:'search_files',arguments:{pattern:'marker'}};
 const message={role:'assistant',stopReason:'toolUse',content:[valid,invalid]};
 hooks.get('message_start')({message},ctx);
 for(const [index,raw]of [[0,'{"path":"D:/fixture.txt"}'],[1,'{"pattern":"marker"']]){
  hooks.get('message_update')({assistantMessageEvent:{type:'toolcall_start',contentIndex:index,partial:message}},ctx);
  hooks.get('message_update')({assistantMessageEvent:{type:'toolcall_delta',contentIndex:index,delta:raw}},ctx);
 }
 const guarded=hooks.get('message_end')({message},ctx).message;
 assert.deepEqual(guarded.content[0].arguments,valid.arguments);
 assert.deepEqual(guarded.content[1].arguments,invalid.arguments);
 assert.equal(hooks.get('tool_call')({toolCallId:'valid'}).block,true);
 const original={role:'toolResult',toolCallId:'invalid',isError:true,content:[{type:'text',text:'Validation failed: pattern is required'}]};
 const contextual=hooks.get('context')({messages:[original]},ctx).messages[0];
 assert.match(JSON.stringify(contextual),/重新生成|纠正/);
 assert.match(JSON.stringify(contextual),/search_files/);
 assert.equal(original.content.length,1,'Do not mutate the persisted result');
});
