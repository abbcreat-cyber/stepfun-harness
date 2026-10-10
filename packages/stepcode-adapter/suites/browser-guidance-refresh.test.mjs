import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { refreshBundledBrowserClient } from "../src/bundled-browser-client.mjs";

test("首次示例一次返回完整只读说明与清单，已有受控标签时不额外读取用户标签", async () => {
  const guide=await readFile(new URL("../../../vendor/step-official-plugins/browser-use/skills/control-browser/SKILL.md",import.meta.url),"utf8");
  const code=[...guide.matchAll(/```js\n([\s\S]*?)\n```/g)].map(m=>m[1]).find(s=>s.includes("const controlledTabs"));
  assert.ok(code);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  for(const tabs of [[],[{id:"known",url:"https://example.com",title:"Existing"}]]){
    const calls=[],outputs=[],users=[{id:"user",url:"https://other.example"}];
    const browser={documentation:async()=>{calls.push("docs");return "COMPLETE API GUIDE"},tabs:{list:async()=>{calls.push("tabs");return tabs}},user:{openTabs:async()=>{calls.push("users");return users}}};
    await new AsyncFunction("browser","nodeRepl",code)(browser,{write:value=>outputs.push(value)});
    assert.deepEqual(calls,tabs.length?["docs","tabs"]:["docs","tabs","users"]);
    assert.deepEqual(outputs,["COMPLETE API GUIDE",{controlledTabs:tabs,userTabs:tabs.length?null:users}]);
  }
});

test("官方旧浏览器指引按哈希迁移并保留名称，重复执行不写，用户修改不覆盖", async t => {
  const root=resolve(process.env.STEP_TEST_ROOT||".release-check/browser-guidance");await mkdir(root,{recursive:true});
  const dir=await mkdtemp(join(root,"case-"));
  assert.ok(resolve(dir).startsWith(root+sep));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const destination=join(dir,"installed"),source=join(dir,"source"),suffix="skills/control-browser/SKILL.md";
  for(const base of [destination,join(source,"browser-use")]){await mkdir(join(base,"scripts"),{recursive:true});await mkdir(join(base,"skills/control-browser"),{recursive:true});await writeFile(join(base,"scripts/browser-client.mjs"),"unchanged client");}
  const old=await readFile(new URL("./fixtures/browser-guidance-v1.md",import.meta.url),"utf8");
  const bundled=await readFile(new URL("../../../vendor/step-official-plugins/browser-use/skills/control-browser/SKILL.md",import.meta.url),"utf8");
  await writeFile(join(source,"browser-use",suffix),bundled);
  const installed=old.replace(/^name:.*$/m,"name: step-builtin-browser-use-control-browser").replaceAll("\n","\r\n");
  await writeFile(join(destination,suffix),installed);
  assert.equal(await refreshBundledBrowserClient(destination,source,"browser-use",{stepOfficial:true}),true);
  const updated=await readFile(join(destination,suffix),"utf8");
  assert.match(updated,/name: step-builtin-browser-use-control-browser/);
  assert.match(updated,/same first call/);
  assert.match(updated,/nodeRepl.write\(\{ controlledTabs, userTabs \}\)/);
  assert.equal(await refreshBundledBrowserClient(destination,source,"browser-use",{stepOfficial:true}),false);
  const custom=installed+"\r\nCustom workflow note.\r\n";await writeFile(join(destination,suffix),custom);
  assert.equal(await refreshBundledBrowserClient(destination,source,"browser-use",{stepOfficial:true}),false);
  assert.equal(await readFile(join(destination,suffix),"utf8"),custom);
  await writeFile(join(destination,suffix),installed);
  assert.equal(await refreshBundledBrowserClient(destination,source,"browser-use",{stepOfficial:false}),false);
  assert.equal(await readFile(join(destination,suffix),"utf8"),installed);
  assert.deepEqual((await readdir(join(destination,"skills/control-browser"))).sort(),["SKILL.md"]);
});
