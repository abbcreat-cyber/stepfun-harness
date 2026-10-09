import { test } from "node:test";
import assert from "node:assert/strict";
import { makeConversationSnapshot } from "../src/conversation-snapshot.mjs";
import { createSessionLifecycle } from "../src/bridge/session-lifecycle.mjs";
import { createSessionMethods } from "../src/bridge/methods-session.mjs";
import { resolveThoughtLevel } from "../src/thought-level-selection.mjs";

test("cold snapshot carries complete saved model intent, never invents absent intent",()=>{
 const selection={providerId:"custom",modelId:"model",options:{reasoningLevel:"enabled",maxOutputTokens:1000}};
 const snap=makeConversationSnapshot({sessionId:"saved",modelSelection:selection});
 assert.deepEqual(snap.config.modelSelection,selection);
 assert.equal(makeConversationSnapshot({sessionId:"empty"}).config.modelSelection,undefined);
});

test("resume thought override goes through the same mapped selection preparation as send",async()=>{
 const session={sessionId:"saved",workspace:{workspacePath:"D:/fixture"},createdAt:1234,modelSelection:{providerId:"mapped",modelId:"model",options:{reasoningLevel:"disabled",maxOutputTokens:1000}},thoughtLevel:"off"};
 const prepared=[];const client={getState:async()=>({model:{provider:"mapped",id:"model"},thinkingLevel:"off"}),getAvailableThinkingLevels:async()=>["off"],setThinkingLevel:async()=>assert.fail('Mapped UI option must not reach native setThinkingLevel')};
 const ctx={primarySession:session,turnBusy:false,resolveThoughtLevel,persistConversation(){},
  runWithPreparedClient:async(options,fn)=>{prepared.push(options);return fn(client);}};
 Object.assign(ctx,createSessionLifecycle(ctx));ctx.restoreSession=async()=>{};
 const result=await createSessionMethods(ctx)["session/resume"]({sessionId:"saved",thoughtLevel:"enabled"});
 assert.equal(prepared[0].selectModel,true);
 assert.deepEqual(prepared[0].selection,{...session.modelSelection,options:{reasoningLevel:"enabled",maxOutputTokens:1000}});
 assert.equal(session.modelSelection.options.reasoningLevel,"enabled");assert.equal(session.thoughtLevel,"off");
 assert.equal(result.session.createdAt,1234);
});
