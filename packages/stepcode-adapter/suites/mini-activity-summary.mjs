import {test} from "node:test";
import assert from "node:assert/strict";
import {createSessionsIndex} from "../src/bridge/sessions-index.mjs";
import {makeSessionsIndexSnapshot} from "../src/wire-shapes.mjs";

test("Mini 活性摘要：等待、后台工作、确认退出均沿索引快照保留", () => {
 let activity={pendingInteractions:[{kind:"permission",payload:{detail:"private command"}},{kind:"userInput"}],backgroundWorks:[{workId:"workflow"}]};
 // 真实会话有工作区引用；摘要必须与订阅身份匹配，不能用缺失身份绕过隔离。
 const ctx={primarySession:{sessionId:"s",createdAt:1,workspace:{workspacePath:"D:/fixture/mini",workspaceKey:"ws",workspaceIdentity:"ws"}},conversationRows:[{kind:"userInput",text:"test"}],turnBusy:true,workflowBridge:{snapshot:()=>activity}};
 const watch=process.env.STEPCODE_BRIDGE_STATE_WATCH;
 process.env.STEPCODE_BRIDGE_STATE_WATCH="0";
 const index=createSessionsIndex(ctx);
 if(watch===undefined)delete process.env.STEPCODE_BRIDGE_STATE_WATCH;else process.env.STEPCODE_BRIDGE_STATE_WATCH=watch;
 let summary=index.makePrimarySessionSummary("ws");
 assert.deepEqual(summary.pendingInteractionSummary,{permissionCount:1,userInputCount:1});
 assert.equal(summary.hasBackgroundWork,true);
 const frame=makeSessionsIndexSnapshot({workspaceId:"ws",logEpoch:"e",sessions:[summary]});
 assert.deepEqual(frame.sessions[0].pendingInteractionSummary,summary.pendingInteractionSummary);
 assert.equal(frame.sessions[0].hasBackgroundWork,true);
 assert.equal(JSON.stringify(frame).includes("private command"),false);
 activity={pendingInteractions:[],backgroundWorks:[]};ctx.turnBusy=false;
 summary=index.makePrimarySessionSummary("ws");
 assert.deepEqual(summary.pendingInteractionSummary,{permissionCount:0,userInputCount:0});
 assert.equal(summary.hasBackgroundWork,false);
 assert.equal(summary.phase,"completedSuccess");
});
