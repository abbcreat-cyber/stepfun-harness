import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {registerFileCheckpoints,checkpointsFor,checkpointPreview,checkpointChanges,applyCheckpoints,hashBytes} from '../src/file-checkpoints.mjs';

test('Windows 同一文件的大小写别名顺序写入归为一个安全撤销链',{skip:process.platform!=='win32'},async()=>{
 const base='D:/Temp/stepcode-history-tests';await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));
 const file=join(root,'MixedCase.txt');await writeFile(file,'original');const entries=[],hooks={};
 registerFileCheckpoints({on:(n,fn)=>hooks[n]=fn,appendEntry:(customType,data)=>entries.push({customType,data:structuredClone(data)})});
 const ctx={cwd:root,sessionManager:{getBranch:()=>[{type:'message',id:'u',message:{role:'user'}}]}};
 for(const [id,path,content] of [['one',file,'first'],['two',file.toUpperCase(),'second']]){
  const e={toolName:'write_file',toolCallId:id,input:{path}};await hooks.tool_call(e,ctx);await writeFile(path,content);await hooks.tool_result(e);
 }
 const files=checkpointsFor(entries,'u');assert.equal(files.length,1);assert.equal((await checkpointPreview(files)).canApply,true);
 const result=await applyCheckpoints(files);assert.equal(result.applied,true);assert.equal(await readFile(file,'utf8'),'original');
 await result.undo();assert.equal(await readFile(file,'utf8'),'second');
});

test('缺失快照不伪造删除统计，明确删除和无变化保持准确',()=>{
 const image=text=>({data:Buffer.from(text).toString('base64'),hash:hashBytes(Buffer.from(text))});
 const before=image('one\ntwo\n');const path='D:/example.txt';
 assert.deepEqual(checkpointChanges([{path,calls:[{toolName:'edit_file',before}]}]),{files:0,additions:0,deletions:0,items:[]});
 assert.equal(checkpointChanges([{path,calls:[{toolName:'edit_file',after:'hash',afterImage:image('after')}]}]).files,0);
 assert.equal(checkpointChanges([{path,calls:[{toolName:'edit_file',before:{hash:before.hash},after:'hash',afterImage:image('after')}]}]).files,0);
 const deleted=checkpointChanges([{path,calls:[{toolName:'edit_file',before,after:'missing',afterImage:{hash:'missing',data:null}}]}]);
 assert.equal(deleted.files,1);assert.equal(deleted.deletions,2);assert.equal(deleted.additions,0);
 assert.equal(checkpointChanges([{path,calls:[{toolName:'edit_file',before,after:before.hash,afterImage:before}]}]).files,0);
});
