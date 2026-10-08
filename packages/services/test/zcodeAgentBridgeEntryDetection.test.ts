/**
 * zcodeAgentProcessManager 桥入口判定 + --log-file 注入的单元测试（评审 R5 low⑩）。
 *
 * isStepCodeBridgeEntry 只认命令位与 args[0] 入口位的 basename：值位 token 撞名
 * （如 --config D:\x\zcode-bridge.mjs）不构成桥入口，不得触发注入与顺带日志清理。
 * 经由已导出的 resolveDefaultZCodeAgentCommand（ZCODE_AGENT_SERVER_COMMAND 显式
 * 覆盖分支）驱动，等价于生产装配路径（stepcodeBackend.ts:139-140 注入同一组 env）。
 *
 * 跑法：packages/services 下 `npx tsx --test test/zcodeAgentBridgeEntryDetection.test.ts`
 * （与 cliProviderSync.test.ts 同款 tsx 前置，见其文件头说明）。
 * 隔离纪律：USERPROFILE 重定向到 mkdtemp 临时目录，homedir() 落点（日志目录创建）
 * 不触碰真实用户家目录；测试结束恢复原 env。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDefaultZCodeAgentCommand } from "../src/zcode-agent/zcodeAgentProcessManager.ts";

const COMMAND_ENV = "ZCODE_AGENT_SERVER_COMMAND";
const ARGS_ENV = "ZCODE_AGENT_SERVER_ARGS_JSON";

/** 在隔离 env 下解析默认 agent 命令（ZCODE_AGENT_SERVER_COMMAND 显式覆盖分支）。 */
function resolveWithOverride(command: string, args: string[]) {
  const savedCommand = process.env[COMMAND_ENV];
  const savedArgs = process.env[ARGS_ENV];
  process.env[COMMAND_ENV] = command;
  process.env[ARGS_ENV] = JSON.stringify(args);
  try {
    return resolveDefaultZCodeAgentCommand({
      workspacePath: "D:\\fixture-workspace",
      workspaceKey: "fixture-workspace",
    });
  } finally {
    if (savedCommand === undefined) delete process.env[COMMAND_ENV];
    else process.env[COMMAND_ENV] = savedCommand;
    if (savedArgs === undefined) delete process.env[ARGS_ENV];
    else process.env[ARGS_ENV] = savedArgs;
  }
}

test("桥入口在 args[0]（command=node）→ 追加 --log-file 指向隔离日志目录", async () => {
  const home = mkdtempSync(join(tmpdir(), "step-entry-detect-"));
  const savedUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    const resolved = resolveWithOverride("node", ["D:\\apps\\bridge\\bin\\zcode-bridge.mjs"]);
    assert.ok(resolved, "显式命令覆盖分支必须返回命令");
    assert.equal(resolved.command, "node");
    const logIndex = resolved.args?.indexOf("--log-file") ?? -1;
    assert.ok(logIndex >= 0, `args 应注入 --log-file，实际：${JSON.stringify(resolved.args)}`);
    const logPath = resolved.args?.[logIndex + 1];
    assert.ok(typeof logPath === "string" && logPath.startsWith(join(home, ".stepcode-desktop", "logs")), `日志文件应落在隔离家目录，实际：${logPath}`);
    assert.ok(existsSync(join(home, ".stepcode-desktop", "logs")), "日志目录已按需创建");
  } finally {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("值位 token 撞名（--config 的值恰叫 zcode-bridge.mjs）→ 不注入不清理，args 原样（R5 low⑩ 回归）", async () => {
  const home = mkdtempSync(join(tmpdir(), "step-entry-detect-"));
  const savedUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    const args = ["app-server", "--config", "D:\\user-files\\zcode-bridge.mjs"];
    const resolved = resolveWithOverride("node", args);
    assert.ok(resolved, "显式命令覆盖分支必须返回命令");
    assert.deepEqual(resolved.args, args, "非桥入口的参数面零改动（不注入 --log-file，不触发目录创建/清理）");
    assert.ok(!existsSync(join(home, ".stepcode-desktop")), "不撞名就不创建日志目录");
  } finally {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("command 自身即桥入口（zcode-bridge-session.mjs）→ 同样注入；session 入口形态同族", async () => {
  const home = mkdtempSync(join(tmpdir(), "step-entry-detect-"));
  const savedUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    const resolved = resolveWithOverride("D:\\apps\\bridge\\bin\\zcode-bridge-session.mjs", ["--stdio"]);
    assert.ok(resolved, "显式命令覆盖分支必须返回命令");
    assert.ok(
      (resolved.args?.includes("--log-file")) ?? false,
      `command 位命中桥入口也应注入，实际：${JSON.stringify(resolved.args)}`,
    );
  } finally {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("显式已带 --log-file → 不重复注入（既有行为回归）", async () => {
  const home = mkdtempSync(join(tmpdir(), "step-entry-detect-"));
  const savedUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    const explicit = ["D:\\apps\\bridge\\bin\\zcode-bridge.mjs", "--log-file", "D:\\custom\\bridge.log"];
    const resolved = resolveWithOverride("node", explicit);
    assert.ok(resolved, "显式命令覆盖分支必须返回命令");
    assert.deepEqual(resolved.args, explicit, "显式 --log-file 优先，不重复注入");
  } finally {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});
