import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkflowBridge} from '../src/workflow/bridge.mjs';

test('empty workflow directory read does not load execution service or create storage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-empty-read-'));
 const bridge=createWorkflowBridge({root,rows:()=>[],session:()=>{throw Error('Empty read must not initialize workflow execution');}});
 assert.deepEqual(await bridge.listRuns('new-session'),[]);
 assert.equal(await access(join(root,'workflows')).then(()=>true).catch(()=>false),false);
});
