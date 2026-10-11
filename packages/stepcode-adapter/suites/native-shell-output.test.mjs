import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {StepStreamProjection} from '../src/stream-projection.mjs';
import {httpFixture,projectedClient} from './provider-wire-fixtures.mjs';
import {toolOutputSchema} from '@zcode/shared/zcode-protocol-v4';
import {nativeShellOutputDisplay} from '../src/native-shell-output.mjs';

test('原生日志路径和截断标记使用现有 bash_output 协议',()=>{
 const rows=[],p=new StepStreamProjection(rows,'t','m');p.handle({type:'tool_execution_end',toolCallId:'a',toolName:'powershell',isError:false,result:{content:[{type:'text',text:'tail'}],details:{fullOutputPath:'D:/logs/中文.log',truncation:{truncated:true}}}});
 assert.equal(rows[0].output.display?.kind,'bash_output');assert.equal(rows[0].output.display.outputPath,'D:/logs/中文.log');assert.equal(rows[0].output.display.output,'tail');assert.equal(toolOutputSchema.parse(rows[0].output).display.truncated,true);
});
test('不猜测 URL、相对路径、未知工具或文案中的完整输出路径',()=>{
 for(const path of ['relative.log','https://example.com/log','file:///D:/log.txt'])assert.equal(nativeShellOutputDisplay('powershell',{details:{fullOutputPath:path}},'output'),null);
 assert.equal(nativeShellOutputDisplay('other',{details:{fullOutputPath:'D:/log'}},'text'),null);
 assert.equal(nativeShellOutputDisplay('powershell',{},'Full output: D:/fake.log'),null);
 assert.equal(nativeShellOutputDisplay('powershell',{details:{truncation:{truncated:true}}},'tail').truncated,true);
 assert.equal(nativeShellOutputDisplay('powershell',{details:{fullOutputPath:'D:/log'}},'a'.repeat(150001)),null);
});
test('真实底座长输出落盘后首尾完整且能投影给前端',{skip:process.platform!=='win32'||!process.env.STEP_TEST_CLI,timeout:30000},async()=>{
 const h=await httpFixture('openai-chat-completions'),f=await projectedClient('openai-chat-completions',h.baseUrl);
 Object.assign(f.client.options.env,{STEPCODE_TASK_MODE:'desktop',STEP_DISABLE_CRON:'1',STEPCODE_STORAGE_ROOT_DIR:f.root+'/state'});
 f.client.handleUiRequests(()=>({confirmed:true}));
 try{
  h.set({kind:'tool',name:'powershell',args:{command:"Write-Output 'OUTPUT_START'; 1..2100 | ForEach-Object { 'ROW_'+$_ }; Write-Output 'OUTPUT_END'"},text:'done'});
  await f.client.start();await f.client.setModel(f.providerId,f.modelId);const events=await f.client.promptAndWait('Run the bounded long-output test.',{timeoutMs:18000});
  const event=events.find(e=>e.type==='tool_execution_end'&&e.toolName==='powershell');assert.equal(event.isError,false,JSON.stringify(event.result).slice(0,500));assert.equal(event.result.details.truncation.truncated,true);
  const rows=[],p=new StepStreamProjection(rows,'t','m');p.handle(event);const path=rows[0].output.display.outputPath;const full=await readFile(path,'utf8');assert.match(full,/OUTPUT_START/);assert.match(full,/OUTPUT_END/);assert.ok(!rows[0].output.text.includes('OUTPUT_START'));
 }finally{await f.client.stop();await h.close()}
});
