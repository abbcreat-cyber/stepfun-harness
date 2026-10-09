import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { desktopShellEnvironment } from "../src/desktop-shell.mjs";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";

test("Git mingw64/bin 布局从安装根定位 Bash，避开 WSL", () => {
  const root = "D:\\Git with spaces";
  const git = win32.join(root, "mingw64", "bin", "git.exe");
  const bash = win32.join(root, "bin", "bash.exe");
  const env = { PATH: `C:\\Windows\\System32;"${win32.dirname(git)}"` };
  const files = new Set([git, bash]);
  const result = desktopShellEnvironment(env, "win32", p => files.has(p));
  assert.equal(result.bash, bash);
  assert.equal(result.env.STEPCODE_GIT_BASH, bash);
  assert.equal(result.env.PATH.split(";")[0], win32.dirname(bash));
  assert.equal(env.STEPCODE_GIT_BASH, undefined);
});

test("缩减 PATH 时从已发现的安装根定位 Bash，保留主环境", () => {
  const env = { Path: "C:\\Windows\\System32", TEST: "keep" };
  const bash = "D:\\Git\\bin\\bash.exe";
  const result = desktopShellEnvironment(env, "win32", p => p === bash, ["D:\\Git"]);
  assert.equal(result.bash, bash);
  assert.equal(result.env.Path, `D:\\Git\\bin;${env.Path}`);
  assert.deepEqual(env, { Path: "C:\\Windows\\System32", TEST: "keep" });
});

test("显式 shell 必须有效，不能静默改用 WSL", () => {
  assert.throws(() => desktopShellEnvironment({ STEPCODE_GIT_BASH: "D:\\missing\\bash.exe" }, "win32", () => false), /Git Bash/);
});

test("bundled document Python uses UTF-8 without changing the parent environment", () => {
  const bash="D:\\Git\\bin\\bash.exe";
  const parent={PATH:"C:\\Windows\\System32",STEPCODE_GIT_BASH:bash,STEPCODE_DOCUMENT_RUNTIME_DIR:"D:\\tools"};
  const result=desktopShellEnvironment(parent,"win32",p=>p===bash);
  assert.equal(result.env.PYTHONUTF8,"1");
  assert.equal(result.env.PYTHONIOENCODING,"utf-8");
  assert.equal(parent.PYTHONUTF8,undefined);
});

test("最小 PATH 同时补齐 Git Bash 与底座的 where.exe 依赖", () => {
  const bash = "D:\\Git\\bin\\bash.exe";
  const files = new Set([bash, "C:\\Windows\\System32\\where.exe"]);
  const parent = { PATH: "D:\\isolated", STEPCODE_GIT_BASH: bash };
  const result = desktopShellEnvironment(parent, "win32", p => files.has(p));
  assert.equal(result.env.PATH, "D:\\Git\\bin;D:\\isolated;C:\\Windows\\System32");
  assert.equal(parent.PATH, "D:\\isolated");
});

test("真实 RPC 子进程遵守会话 PATH 覆盖并统一大小写", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "step-shell-env-"));
  const bash = join(root, "bash.exe");
  await writeFile(bash, "fixture");
  const command = [process.execPath, "-e", 'process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",d=>{s+=d;let i;while((i=s.indexOf("\\n"))>=0){const c=JSON.parse(s.slice(0,i));s=s.slice(i+1);process.stdout.write(JSON.stringify({type:"response",id:c.id,command:c.type,success:true,data:{path:process.env.Path??process.env.PATH,bash:process.env.STEPCODE_GIT_BASH}})+"\\n")}})'];
  const childPath = "D:\\session-only";
  const client = new StepCodeRpcClient({ communicationMode: "mock", command, env: { PATH: childPath, STEPCODE_GIT_BASH: bash } });
  try {
    const starting = client.start();
    await assert.rejects(client.start(), /already started/);
    await starting;
    const state = await client.getState();
    assert.equal(state.path, `${root};${childPath};${win32.join(process.env.SystemRoot || "C:\\Windows", "System32")}`);
    assert.equal(state.bash, bash);
  } finally { await client.stop(); await rm(root, { recursive: true, force: true }); }
});
