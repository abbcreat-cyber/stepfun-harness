import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {findTool} from "../../../vendor/step-official-plugins/android-emulator/dist/providers/sdk.js";
import {officialPluginCallTimeout} from "../src/official-plugin-timeout.mjs";
import {run} from "../../../vendor/step-official-plugins/android-emulator/dist/lib/run.js";
import {readFile} from "node:fs/promises";
test("Android command timeout also ends the descendant holding its output pipe",{skip:process.platform!=="win32",timeout:5000},async()=>{
 const root=await mkdtemp("D:/Temp/android-timeout-");const marker=join(root,"child.pid");
 try{
 const code='const {spawn}=require("child_process"); const fs=require("fs"); const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);';
 const start=Date.now();const result=await run([process.execPath,"-e",code,marker],{timeout:500});
 assert.equal(result.timed,true);assert.ok(Date.now()-start<4000);
 const pid=Number(await readFile(marker,"utf8"));assert.throws(()=>process.kill(pid,0),/ESRCH|no such process/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("Android camelCase execution deadlines do not expire in the bridge first",()=>{
 assert.equal(officialPluginCallTimeout("android-emulator","android_build_app",{timeoutMs:300000}),450000);
 assert.equal(officialPluginCallTimeout("android-emulator","android_build_and_run"),960000);
 assert.equal(officialPluginCallTimeout("browser-use","js",{timeout_ms:1234}),1234);
 assert.throws(()=>officialPluginCallTimeout("android-emulator","android_build_app",{timeoutMs:-1}));
});
test("Android plugin resolves Windows CRLF where output to a runnable Gradle launcher",{skip:process.platform!=="win32"},async()=>{
 const root=await mkdtemp("D:/Temp/android-tool-");const prior=process.env.PATH;
 try{await writeFile(join(root,"audit-gradle"),"#!/bin/sh\n");await writeFile(join(root,"audit-gradle.bat"),"@exit /b 0\r\n");process.env.PATH=root+";"+process.env.SystemRoot+"\\System32";
 assert.equal(await findTool("audit-gradle"),join(root,"audit-gradle.bat"));
 }finally{process.env.PATH=prior;await rm(root,{recursive:true,force:true});}
});
