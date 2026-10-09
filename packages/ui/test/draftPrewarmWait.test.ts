import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DraftSessionPrewarmCoordinator} from '../src/v4/composer/useDraftSessionPrewarm.js';
import type {CommandAck} from '@zcode/shared/zcode-protocol-v4';

test('send joins in-flight draft creation and promotion does not delete the accepted session', async()=>{
 let complete!: (ack:CommandAck)=>void;
 const commands:string[]=[];
 const owner=new DraftSessionPrewarmCoordinator('workspace',async type=>{commands.push(type);return new Promise<CommandAck>(r=>{complete=r})},undefined,()=>{});
 const release=owner.acquire({invalidationVersion:1,onBinding:()=>{}});
 const waiting=owner.waitForBinding(1);
 assert.deepEqual(commands,['createSession']);
 complete({commandId:'create',status:'accepted',revisionAtDecision:0,result:{type:'createSession',sessionId:'ready'}});
 const binding=await waiting;assert.equal(binding?.sessionId,'ready');assert.equal(binding?.beginPromotion(),true);binding?.promote();release();
 await new Promise(r=>setTimeout(r,5));assert.deepEqual(commands,['createSession']);
});
test('retired generation cannot supply a late binding to another draft',async()=>{
 let complete!: (ack:CommandAck)=>void;
 const owner=new DraftSessionPrewarmCoordinator('workspace',async type=>type==='createSession'?new Promise<CommandAck>(r=>{complete=r}):{commandId:'delete',status:'accepted',revisionAtDecision:0},undefined,()=>{});
 const release=owner.acquire({invalidationVersion:1,onBinding:()=>{}});
 const waiting=owner.waitForBinding(1);release();await new Promise(r=>setTimeout(r,5));
 complete({commandId:'create',status:'accepted',revisionAtDecision:0,result:{type:'createSession',sessionId:'late'}});
 assert.equal(await waiting,null);assert.equal(await owner.waitForBinding(2),null);
});
