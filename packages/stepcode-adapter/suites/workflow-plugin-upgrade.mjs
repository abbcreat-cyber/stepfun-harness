import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,access,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { installWorkflowPlugin } from '../src/workflow/plugin-install.mjs';

const legacy=root=>({id:'step_workflows',name:'工作流',version:'1.0.0',custom:'keep',mcpServers:{other:{command:'keep'},step_workflows:{command:'old-node',args:['D:/old/resources/harness-runtime/adapter/bin/workflow-mcp.mjs','--bridge-dir',join(root,'browser-bridges')],timeoutMs:15000,env:{EXAMPLE:'keep'}}}});
test('legacy install follows new entry while preserving configuration and no-op writes',async()=>{
 const root=await mkdtemp('D:/Temp/workflow-upgrade-'),dir=join(root,'plugins','step_workflows');await mkdir(dir,{recursive:true});const file=join(dir,'step.plugin.json');await writeFile(file,JSON.stringify(legacy(root)));await Promise.all([installWorkflowPlugin(root),installWorkflowPlugin(root)]);
 const value=JSON.parse(await readFile(file,'utf8'));assert.equal(value.stepManagedWorkflow,true);assert.equal(value.mcpServers.step_workflows.command,process.execPath);assert.match(value.mcpServers.step_workflows.args[0],/stepcode-adapter[\\/]bin[\\/]workflow-mcp.mjs$/);assert.equal(value.custom,'keep');assert.equal(value.mcpServers.other.command,'keep');assert.equal(value.mcpServers.step_workflows.timeoutMs,15000);assert.deepEqual(value.mcpServers.step_workflows.env,{EXAMPLE:'keep'});const before=(await stat(file)).mtimeMs;await installWorkflowPlugin(root);assert.equal((await stat(file)).mtimeMs,before);
});
test('both disabled layouts stay disabled and custom namesakes remain untouched',async()=>{
 for(const [parent,name] of [['plugins','step.plugin.disabled.json'],['disabled-plugins','step.plugin.json']]){const root=await mkdtemp('D:/Temp/workflow-disabled-'),dir=join(root,parent,'step_workflows');await mkdir(dir,{recursive:true});await writeFile(join(dir,name),JSON.stringify(legacy(root)));await installWorkflowPlugin(root);assert.equal(JSON.parse(await readFile(join(dir,name),'utf8')).stepManagedWorkflow,true);assert.equal(await access(join(root,'plugins','step_workflows','step.plugin.json')).then(()=>true).catch(()=>false),false);}
 const root=await mkdtemp('D:/Temp/workflow-custom-'),dir=join(root,'plugins','step_workflows');await mkdir(dir,{recursive:true});const value=legacy(root);value.mcpServers.step_workflows.args=['D:/my-tools/workflow-mcp.mjs','--bridge-dir',join(root,'browser-bridges')];const body=JSON.stringify(value);await writeFile(join(dir,'step.plugin.json'),body);await installWorkflowPlugin(root);assert.equal(await readFile(join(dir,'step.plugin.json'),'utf8'),body);
});
