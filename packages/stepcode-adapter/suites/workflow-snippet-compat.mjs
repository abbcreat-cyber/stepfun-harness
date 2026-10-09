import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {mkdtemp} from 'node:fs/promises';
import {startEmbeddedBrowserRelay} from '../src/embedded-browser-relay.mjs';
import {validateSnippetMetadata,snippetResult,snippetDisplay} from '../src/workflow/snippet-result.mjs';
import {StepStreamProjection} from '../src/stream-projection.mjs';
import {register} from 'tsx/esm/api';
register();
const {toolCallEvalWorkflowSnippetDisplaySchema}=await import('@zcode/shared/zcode-protocol-v4');

test('title is explicit MCP metadata while unknown fields remain forbidden',async t=>{
 const root=await mkdtemp('D:/Temp/snippet-schema-');
 const relay=await startEmbeddedBrowserRelay({directory:root,getContext:()=>({sessionId:'schema'}),requestHost:async()=>({})});await relay.bindPid(process.pid);t.after(()=>relay.close());
 const child=spawn(process.execPath,[fileURLToPath(new URL('../bin/workflow-mcp.mjs',import.meta.url)),'--bridge-dir',root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const reader=createInterface({input:child.stdout});t.after(()=>{reader.close();child.kill()});
 const response=once(reader,'line');child.stdin.write(JSON.stringify({id:1,method:'tools/list'})+'\n');
 const tool=JSON.parse((await response)[0]).result.tools.find(t=>t.name==='EvalWorkflowSnippet');
 assert.equal(tool.inputSchema.properties.title.type,'string');assert.equal(tool.inputSchema.properties.title.maxLength,160);assert.equal(tool.inputSchema.additionalProperties,false);
 validateSnippetMetadata({code:'return 1;',title:'验证环境',timeoutMs:60000});
 assert.throws(()=>validateSnippetMetadata({code:'return 1;',typo:true}),/未知/);
 assert.throws(()=>validateSnippetMetadata({code:'return 1;',title:5}),/title/);
});
test('real snippet result reaches the existing typed display and preserves returned evidence',()=>{
 const value=snippetResult({ok:true,kind:'completed',artifact:{nodeOk:true,gitOk:false},logs:['not a git repository']},Date.now()-10);
 assert.equal(value.ok,true);const display=snippetDisplay('EvalWorkflowSnippet',JSON.stringify(value));assert.ok(toolCallEvalWorkflowSnippetDisplaySchema.safeParse(display).success);assert.ok(display.durationMs>=10);
 const rows=[],projection=new StepStreamProjection(rows,'turn','step');
 projection.handle({type:'tool_execution_start',toolCallId:'call',toolName:'step_workflows__step_workflows__EvalWorkflowSnippet',args:{code:'return 1;',title:'验证环境'}});
 projection.handle({type:'tool_execution_end',toolCallId:'call',result:{content:[{type:'text',text:JSON.stringify(value)}]},isError:false});
 assert.equal(rows[0].status,'success');assert.deepEqual(rows[0].display,display);assert.equal(rows[0].input.title,'验证环境');
});
test('failed and cancelled snippets cannot become success displays',()=>{
 for(const status of ['denied','cancelled']){const value=snippetResult({ok:false,status,executed:false},Date.now());assert.equal(snippetDisplay('EvalWorkflowSnippet',JSON.stringify(value)).ok,false);}
 const value=snippetResult({ok:false,diagnostics:[{line:1,column:2,code:123,message:'error'}],executed:false},Date.now());assert.ok(toolCallEvalWorkflowSnippetDisplaySchema.safeParse(snippetDisplay('EvalWorkflowSnippet',JSON.stringify(value))).success);
});
test('display bounds large output and ignores malformed or unrelated payloads',()=>{
 const value=snippetResult({ok:true,artifact:'x'.repeat(5000),logs:Array(45).fill('y'.repeat(2000))},Date.now());
 const display=snippetDisplay('EvalWorkflowSnippet',JSON.stringify(value));assert.equal(display.truncated,true);assert.ok(toolCallEvalWorkflowSnippetDisplaySchema.safeParse(display).success);
 assert.equal(snippetDisplay('other',JSON.stringify(value)),undefined);assert.equal(snippetDisplay('EvalWorkflowSnippet','broken'),undefined);assert.equal(snippetDisplay('EvalWorkflowSnippet',JSON.stringify({...value,logs:[5]})),undefined);
});
