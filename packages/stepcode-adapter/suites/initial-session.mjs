import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeCreatedSession } from '../src/initial-session.mjs';

const fresh=()=>({getState:async()=>({messageCount:0,pendingMessageCount:0,isStreaming:false,isCompacting:false}),getMessages:async()=>[],resets:0,async newSession(){this.resets++;}});
test('fresh empty CLI session avoids duplicate initialization, later creates still reset',async()=>{
 const client=fresh();await initializeCreatedSession(client,['step','--mode','rpc']);assert.equal(client.resets,0);
 await initializeCreatedSession(client);assert.equal(client.resets,1);
});
test('resumed, populated, pending or unknown sessions are never adopted',async()=>{
 for(const command of [['step','--continue'],['step','--session=x'],['step','-r']]){const c=fresh();await initializeCreatedSession(c,command);assert.equal(c.resets,1);}
 for(const override of [{messageCount:1},{pendingMessageCount:1},{isStreaming:true},{isCompacting:true},{messageCount:undefined}]){const c=fresh();const get=c.getState;c.getState=async()=>({...await get(),...override});await initializeCreatedSession(c);assert.equal(c.resets,1);}
 const c=fresh();c.getMessages=async()=>[{role:'user',content:'history'}];await initializeCreatedSession(c);assert.equal(c.resets,1);
});
test('state read failure is not masked or accepted',async()=>{
 const c=fresh();c.getState=async()=>{throw Error('unavailable')};await assert.rejects(initializeCreatedSession(c),/unavailable/);assert.equal(c.resets,0);
});
