export const stepMiniContent = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; object-src 'none'">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:transparent;color:#f0f0f0;font-family:'Segoe UI','Microsoft YaHei',sans-serif;font-size:var(--ui-font-size,14px);overflow:hidden}
body{--surface:#242424;--line:#484848;--subtle:#aaa;--hover:#343434;--count:#49b55f;--count-text:#fff}body.light{color:#222;--surface:#fafafa;--line:#d5d5d5;--subtle:#777;--hover:#eaeef2;--count:#319847}
button{font:inherit;color:inherit;border:0;cursor:pointer;background:transparent;-webkit-app-region:no-drag}button:focus-visible{outline:2px solid #7bc3ff;outline-offset:2px}
/* 长标题不能撑开 grid 的隐式最小列宽；滚动条不绘制，窄屏仍保留纵向滚轮访问。 */
#tasks{position:absolute;left:10px;right:10px;bottom:72px;display:grid;grid-template-columns:minmax(0,1fr);gap:8px;max-height:calc(100% - 86px);overflow-x:hidden;overflow-y:auto;scrollbar-width:none;transform-origin:bottom right;opacity:0;visibility:hidden}#tasks::-webkit-scrollbar{display:none;width:0;height:0}#tasks[hidden]{display:none}body[data-direction=down] #tasks{bottom:auto;top:72px;transform-origin:top right}
.task{display:flex;align-items:center;text-align:left;gap:10px;width:100%;min-width:0;max-width:100%;overflow:hidden;height:64px;flex-shrink:0;padding:10px 16px;border:1px solid var(--line);background:var(--surface);border-radius:24px;box-shadow:0 4px 12px #0002;transition:background 140ms ease}.task:hover{background:var(--hover)}.text{min-width:0;flex:1}.title{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}.text-ui-caption{font-size:calc(var(--ui-font-size,14px)*.86)}.status{display:block;color:var(--subtle);margin-top:3px}.dot{width:7px;height:7px;flex-shrink:0;border-radius:50%;background:#909090}.dot.running{background:#7bc3ff;animation:pulse 1.7s ease-in-out infinite}.dot.attention{background:#edb968}
#bar{position:absolute;right:10px;bottom:10px;width:240px;height:52px;display:flex;align-items:center;justify-content:center;gap:5px;border:1px solid var(--line);background:var(--surface);border-radius:28px;box-shadow:0 6px 20px #0003;-webkit-app-region:drag}body[data-direction=down] #bar{bottom:auto;top:10px}
#bar button{position:relative;width:42px;height:34px;border-radius:18px;display:grid;place-items:center;transition:background 140ms ease}#bar button:hover{background:var(--hover)}.separator{height:19px;width:1px;background:var(--line)}svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}#star{color:#83c9ff}#caret{transition:transform 240ms cubic-bezier(.22,1,.36,1);transform-origin:center}#expand[aria-expanded=true] #caret{transform:rotate(180deg)}
#count{position:absolute;right:0;top:-3px;min-width:18px;height:18px;padding:0 4px;display:grid;place-items:center;border-radius:10px;background:var(--count);color:var(--count-text);font-weight:600;line-height:1;font-variant-numeric:tabular-nums;box-shadow:0 0 0 2px var(--surface);pointer-events:none}#count[hidden]{display:none}
@keyframes pulse{50%{opacity:.35}}@media(prefers-reduced-motion:reduce){.dot{animation:none!important}#caret,.task,#bar button{transition:none!important}}
</style></head><body data-direction="up"><div id="tasks" hidden inert></div><div id="bar">
<button id="star" title="打开 Step Code" aria-label="打开 Step Code"><img src="__STEPCODE_APP_ICON__" alt="" width="26" height="26" draggable="false"></button>
<span class="separator"></span><button id="new" title="新建任务" aria-label="新建任务"><svg viewBox="0 0 24 24"><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M15 3l6 6M10 14l2-6 6-6 6 6-6 6Z"/></svg></button>
<span class="separator"></span><button id="expand" title="展开任务" aria-label="展开任务" aria-expanded="false"><svg id="caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg><span id="count" class="text-ui-caption" hidden aria-hidden="true"></span></button><button id="hide" title="隐藏 Mini" aria-label="隐藏 Mini"><svg viewBox="0 0 24 24"><path d="m8 8 8 8m0-8-8 8"/></svg></button></div>
<script>
let expanded=false,snapshot={tasks:[],dark:true,locale:'zh-CN'},signature='',panelWanted=false,transition=0,animation;
const api=window.stepMini,box=document.getElementById('tasks'),expandButton=document.getElementById('expand');
function layout(value){document.body.dataset.direction=value.direction}
api.onLayout(layout);
async function presentPanel(open){
 if(panelWanted===open)return;panelWanted=open;const serial=++transition;
 const previous={opacity:getComputedStyle(box).opacity,transform:getComputedStyle(box).transform};animation?.cancel();
 if(open){layout(await api.expand(true));if(serial!==transition)return;await new Promise(requestAnimationFrame);if(serial!==transition)return;box.hidden=false;box.style.visibility='visible';box.inert=false}else{box.inert=true}
 const offset=document.body.dataset.direction==='down'?-6:6;
 const hidden={opacity:0,transform:'translateY('+offset+'px) scale(.985)'},visible={opacity:1,transform:'translateY(0) scale(1)'};
 const start=previous.opacity==='0'&&open?hidden:previous;
 animation=box.animate([start,open?visible:hidden],{duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:open?240:180,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'});
 try{await animation.finished}catch{return}if(serial!==transition)return;
 box.style.opacity=open?'1':'0';box.style.transform=open?'none':hidden.transform;animation.cancel();animation=null;
 if(!open){box.hidden=true;box.style.visibility='hidden';await api.expand(false)}
}
function render(){
 document.body.style.setProperty('--ui-font-size',(snapshot.fontSize||14)+'px');const english=snapshot.locale.startsWith('en');document.body.classList.toggle('light',!snapshot.dark);
 const count=snapshot.activeTaskCount??snapshot.tasks.length,badge=document.getElementById('count');badge.hidden=count===0;badge.textContent=count>99?'99+':String(count);
 const label=english?(expanded?'Collapse tasks':'Expand tasks'):(expanded?'收起任务':'展开任务'),countLabel=english?count+' active tasks':count+' 个进行中任务';expandButton.title=label+(count?' · '+countLabel:'');expandButton.setAttribute('aria-label',expandButton.title);expandButton.setAttribute('aria-expanded',String(expanded));
 const next=JSON.stringify([snapshot.locale,snapshot.tasks.map(task=>[task.key,task.title,task.state])]);
 // 高频 activity 帧不重建同一批卡片；最后一张结束时保留旧 DOM 直到渐隐完成。
 if(next!==signature&&(snapshot.tasks.length||box.hidden)){signature=next;box.replaceChildren();for(const task of snapshot.tasks){const button=document.createElement('button');button.className='task';button.dataset.taskKey=task.key;const dot=document.createElement('span');dot.className='dot '+task.state;const text=document.createElement('span');text.className='text';const title=document.createElement('span');title.className='title';title.textContent=task.title||task.taskId;const status=document.createElement('span');status.className='status text-ui-caption';status.textContent=english?(task.state==='attention'?'Needs your input':'Working'):(task.state==='attention'?'等待你处理':'正在工作');text.append(title,status);button.append(dot,text);button.onclick=()=>api.openTask(task.key);box.append(button)}}
 void presentPanel(expanded&&snapshot.tasks.length>0);
}
api.onSnapshot(value=>{snapshot=value;render()});api.read().then(value=>{snapshot=value;render()});expandButton.onclick=()=>{expanded=!expanded;render()};document.getElementById('new').onclick=()=>api.newTask();document.getElementById('hide').onclick=()=>api.hide();document.getElementById('star').onclick=()=>snapshot.tasks[0]?api.openTask(snapshot.tasks[0].key):api.newTask();
</script></body></html>`;
