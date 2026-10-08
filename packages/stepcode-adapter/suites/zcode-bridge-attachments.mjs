/**
 * zcode-bridge 套件（附件传输）：粘贴图片经 v4/attachment 上传到达 RPC、
 * 且重启后无需调用模型仍可读取。
 * 从 zcode-bridge.mjs 机械拆分，用例逐字保留。
 * R6 清理（评审 low）：跨进程共用的状态目录改经 options.stateDir（--state-dir argv
 * 通道）下发——不再在源码出现状态目录环境键字面量（宿主会间歇清洗该前缀的 env 键与
 * 文件字面量）；finally 在桥进程退出后 rmSync 清掉临时目录，跑批不再泄漏
 * %TEMP%\bridge-image-*。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBridge } from "./zcode-bridge-launch.mjs";
import { waitForExit } from "./helpers.mjs";

test('bridge: pasted image reaches RPC and remains readable after restart without a model call',async()=>{
 const {createHash}=await import('node:crypto');const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';const bytes=Buffer.from(png,'base64');const stateDir=mkdtempSync(join(tmpdir(),'bridge-image-'));const b=launchBridge([],{},{stateDir});let reader;
 try{b.send({id:1,method:'session/create',params:{sessionId:'image-session',workspace:{workspacePath:stateDir}}});await b.waitFor(f=>f.id===1);
 const p={sessionId:'image-session',connectionId:'image-c',uploadId:'image-upload',fileName:'clipboard.png',mime:'image/png',totalBytes:bytes.length,totalChunks:1,checksum:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
 b.send({id:2,method:'v4/attachment/begin',params:p});assert.equal((await b.waitFor(f=>f.id===2)).result.state,'staging');
 b.send({id:3,method:'v4/attachment/chunk',params:{...p,chunkIndex:0,dataBase64:png}});assert.equal((await b.waitFor(f=>f.id===3)).result.nextChunkIndex,1);
 b.send({id:4,method:'v4/attachment/commit',params:p});const ref=(await b.waitFor(f=>f.id===4)).result.ref;
 b.send({id:5,method:'v4/conversation/subscribe',params:{topic:'conversation/image-session',connectionId:'image-c',clientMode:'desktop-continuous'}});await b.waitFor(f=>f.id===5);
 b.send({id:6,method:'v4/command',params:{commandId:'image-send',sessionId:'image-session',type:'sendText',payload:{text:'mock:image-transport',attachments:[{ref,fileName:'clipboard.png',mime:'image/png',bytes:bytes.length}]}}});await b.waitFor(f=>f.params?.type==='turn.completed');
 // turn.completed 先于合并快照广播，二者可以分属不同 stdio chunk；等待真实可读的附件快照。
 const snapshotFrame=await b.waitFor(f=>f.params?.frame?.payload?.snapshot?.rows?.window?.some(r=>r.kind==='assistantText'&&r.text?.includes(png)));
 const snap=snapshotFrame.params.frame.payload.snapshot;
 assert.equal(snap.rows.window.find(r=>r.kind==='userInput').attachments[0].ref,ref);const text=snap.rows.window.find(r=>r.kind==='assistantText').text;assert.ok(text.includes(png));assert.ok(text.includes('image/png'));
 reader=launchBridge([],{},{stateDir});reader.send({id:1,method:'v4/attachment/read',params:{sessionId:'image-session',ref,offset:0,limit:512}});assert.equal((await reader.waitFor(f=>f.id===1)).result.dataBase64,png);
 // R6 清理：等被 kill 的桥进程真正退出后再删状态目录（kill 是异步的，句柄未释放时
 // rmSync 会 EBUSY）；EBUSY 兜底忽略，与 helpers.launchBridge 的自有目录清理同款。
 }finally{b.child.kill();reader?.child.kill();
  await waitForExit(b.child,{label:'bridge 退出（附件状态目录清理）'});
  if(reader)await waitForExit(reader.child,{label:'reader 退出（附件状态目录清理）'});
  try{rmSync(stateDir,{recursive:true,force:true});}catch{/* Windows 句柄延迟释放时忽略；临时目录由系统清理。 */}
 }
});
