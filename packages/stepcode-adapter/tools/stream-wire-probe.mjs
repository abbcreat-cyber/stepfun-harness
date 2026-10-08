import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {conversationTopicFrameSchema} from '../../shared/src/zcode-protocol-v4/transport.ts';
import {applyConversationDeltas} from '../../shared/src/zcode-protocol-v4/apply.ts';
const dir=await mkdtemp(join(tmpdir(),'step-stream-schema-'));
const child=spawn(process.execPath,['packages/stepcode-adapter/bin/zcode-bridge.mjs'],{stdio:['pipe','pipe','pipe'],env:{...process.env,STEPCODE_BRIDGE_STATE_DIR:dir,STEP_MOCK_DELAY_MS:'80'}});
let buffer='',snapshot=null,count=0,deltaCount=0;const frames=[];
child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const f=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);frames.push(f);if(f.method==='v4/conversation/frame'){const inner=conversationTopicFrameSchema.parse(f.params.frame);count++;if(inner.payload.kind==='snapshot'){snapshot=inner.payload.snapshot;}else{if(inner.fromSeq!==snapshot.seq)throw Error('sequence gap');snapshot={...applyConversationDeltas(snapshot,inner.payload.deltas),seq:inner.toSeq};deltaCount++;}}}});
function request(id,method,params){child.stdin.write(JSON.stringify({id,method,params})+'\n');return wait(f=>f.id===id);}
async function wait(predicate){const deadline=Date.now()+15000;while(Date.now()<deadline){const f=frames.find(predicate);if(f)return f;await new Promise(r=>setTimeout(r,20));}throw Error('timeout');}
try{
await request(1,'session/create',{sessionId:'schema-stream',workspace:{workspacePath:'C:/tmp/schema-stream'}});
await request(2,'v4/conversation/subscribe',{topic:'conversation/schema-stream',connectionId:'schema',clientMode:'desktop-continuous'});
await request(3,'v4/command',{commandId:'schema-cmd',type:'sendText',sessionId:'schema-stream',payload:{text:'mock:tool'}});
await wait(f=>f.params?.type==='turn.completed');
if(deltaCount<3)throw Error('not streaming');console.log(JSON.stringify({validFrames:count,deltaFrames:deltaCount,rows:snapshot.rows.window.map(r=>({kind:r.kind,state:r.state??r.status}))}));
}finally{child.stdin.end();await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true});}
