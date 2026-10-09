import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isMissingBundledPlugin, retireMissingBundledPlugins } from "../src/builtin-plugin-availability.mjs";
test("missing auto-preinstalled binary cannot remain enabled; custom plugins are retained",async()=>{
 const manifest={id:"steppage",provision:{installer:"steppageInstaller"},mcpServers:{steppage:{command:"steppage-mcp"}}};
 assert.equal(isMissingBundledPlugin(manifest,{PATH:"D:/missing"},()=>false),true);
 assert.equal(isMissingBundledPlugin(manifest,{PATH:"D:/available"},p=>p.endsWith("steppage-mcp.exe")||p.endsWith("steppage-mcp")),false);
 assert.equal(isMissingBundledPlugin({...manifest,provision:undefined},{PATH:""},()=>false),false);
 const root=await mkdtemp("D:/Temp/builtin-availability-");
 try{await mkdir(join(root,"plugins/steppage"),{recursive:true});await writeFile(join(root,"plugins/steppage/step.plugin.json"),JSON.stringify(manifest));
 if(isMissingBundledPlugin(manifest)){await retireMissingBundledPlugins(root);await retireMissingBundledPlugins(root);assert.deepEqual(JSON.parse(await readFile(join(root,"plugins/.stepcode-preinstalled"))),["steppage"]);await assert.rejects(readFile(join(root,"plugins/steppage/step.plugin.json")),{code:"ENOENT"});assert.deepEqual(JSON.parse(await readFile(join(root,"plugins/steppage/step.plugin.disabled.json"))),manifest);}
 }finally{await rm(root,{recursive:true,force:true});}
});
