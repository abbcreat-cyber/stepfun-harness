import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { readStepPluginSkillRoots } from "../src/skills/stepPluginSkillRoots.ts";
import { StepCodeRpcClient } from "../../stepcode-adapter/src/rpc-client.mjs";
import {
  pluginConfigSignature,
  syncOfficialNodeHost,
} from "../../stepcode-adapter/src/official-plugins.mjs";
import { createStepPluginHandlers } from "../../stepcode-adapter/src/plugins.mjs";

test("Step skill menu reads the same active plugin directories as the runtime", async () => {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "step-skill-owner-"));
  const oldBackend = process.env.STEP_BACKEND,
    oldRoot = process.env.STEPCODE_STORAGE_ROOT_DIR;
  try {
    process.env.STEP_BACKEND = "stepcode-local";
    process.env.STEPCODE_STORAGE_ROOT_DIR = root;
    const plugin = join(root, "plugins/pdf");
    await mkdir(join(plugin, "skills/pdf"), { recursive: true });
    await writeFile(
      join(plugin, "skills/pdf/SKILL.md"),
      "---\nname: pdf\ndescription: fixture\n---\nFixture",
    );
    await writeFile(
      join(plugin, "step.plugin.json"),
      JSON.stringify({ id: "pdf", stepOfficial: true, skills: ["skills", "../../outside"] }),
    );
    const roots = await readStepPluginSkillRoots();
    assert.equal(roots?.length, 1);
    assert.equal(roots?.[0]?.pluginId, "pdf@zcode-plugins-official");
    await mkdir(join(root, "disabled-plugins"));
    await rename(plugin, join(root, "disabled-plugins/pdf"));
    assert.deepEqual(await readStepPluginSkillRoots(), []);
    delete process.env.STEP_BACKEND;
    assert.equal(await readStepPluginSkillRoots(), null);
  } finally {
    if (oldBackend === undefined) delete process.env.STEP_BACKEND;
    else process.env.STEP_BACKEND = oldBackend;
    if (oldRoot === undefined) delete process.env.STEPCODE_STORAGE_ROOT_DIR;
    else process.env.STEPCODE_STORAGE_ROOT_DIR = oldRoot;
  }
});

test("host manifest RMW excludes concurrent skill toggle and directory move without losing either field", async () => {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "step-skill-race-"));
  const oldBackend = process.env.STEP_BACKEND,
    oldRoot = process.env.STEPCODE_STORAGE_ROOT_DIR,
    oldHome = process.env.HOME;
  const originalReadFile = fs.promises.readFile;
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let syncing: Promise<unknown> | undefined, toggling: Promise<unknown> | undefined;
  try {
    process.env.STEP_BACKEND = "stepcode-local";
    process.env.STEPCODE_STORAGE_ROOT_DIR = root;
    process.env.HOME = root;
    const plugin = join(root, "plugins/browser-use"),
      file = join(plugin, "step.plugin.json"),
      runtime = join(plugin, "step-official-runtime.json");
    await mkdir(join(plugin, "skills/browser"), { recursive: true });
    await writeFile(
      join(plugin, "skills/browser/SKILL.md"),
      "---\nname: browser-fixture\ndescription: fixture\n---\nFixture",
    );
    await writeFile(
      file,
      JSON.stringify({ id: "browser-use", stepOfficial: true, skills: ["skills"], mcpServers: {} }),
    );
    await writeFile(runtime, JSON.stringify({ servers: {} }));
    const { createSkillsService } = await import("../src/skills/skillsService.ts");
    const service = createSkillsService({ isDesktopRuntime: false });
    const skill = (await service.list({ workspacePath: root })).skills[0]!;
    let intercept = true;
    // 宿主已读旧 manifest 后暂停，精确重现原先覆盖单技能选择的交错点。
    fs.promises.readFile = (async (...args: Parameters<typeof originalReadFile>) => {
      if (intercept && args[0] === runtime) {
        intercept = false;
        reached.resolve();
        await release.promise;
      }
      return originalReadFile(...args);
    }) as typeof originalReadFile;
    syncBuiltinESMExports();
    syncing = syncOfficialNodeHost(root);
    await reached.promise;
    let toggleSettled = false;
    toggling = service
      .setEnabled({ workspacePath: root, skillId: skill.id, enabled: false })
      .finally(() => {
        toggleSettled = true;
      });
    await delay(75);
    assert.equal(toggleSettled, false, "skill writer must wait while host holds manifest RMW lock");
    release.resolve();
    await Promise.all([syncing, toggling]);
    const manifest = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(manifest.skills, []);
    assert.deepEqual(manifest.stepSkillSelection.disabled, ["skills/browser/SKILL.md"]);
    assert.ok(manifest.mcpServers.node_repl);
    const stable = await readFile(file, "utf8");
    await syncOfficialNodeHost(root);
    assert.equal(await readFile(file, "utf8"), stable);
    // 整体开关也走同一锁，恢复后保留单技能选择。
    const handlers = createStepPluginHandlers(root, { officialSource: join(root, "empty-source") });
    await handlers["plugins/setEnabled"]({
      pluginId: "browser-use@zcode-plugins-official",
      enabled: false,
    });
    await handlers["plugins/setEnabled"]({
      pluginId: "browser-use@zcode-plugins-official",
      enabled: true,
    });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).skills, []);
    assert.equal((await service.list({ workspacePath: root })).skills[0]?.enabled, false);
    await assert.rejects(readFile(join(root, ".zcode/cli/config.json")), { code: "ENOENT" });
    const thirdParty = JSON.stringify({ id: "browser-use", skills: ["skills"], mcpServers: {} });
    await writeFile(file, thirdParty);
    await rename(runtime, `${runtime}.fixture-original`);
    await syncOfficialNodeHost(root);
    assert.equal(
      await readFile(file, "utf8"),
      thirdParty,
      "same-name user plugin is not owned by official sync",
    );
  } finally {
    release.resolve();
    await Promise.allSettled([syncing, toggling]);
    fs.promises.readFile = originalReadFile;
    syncBuiltinESMExports();
    if (oldBackend === undefined) delete process.env.STEP_BACKEND;
    else process.env.STEP_BACKEND = oldBackend;
    if (oldRoot === undefined) delete process.env.STEPCODE_STORAGE_ROOT_DIR;
    else process.env.STEPCODE_STORAGE_ROOT_DIR = oldRoot;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("Step service toggle changes actual plugin discovery while retaining source and independent plugin enable", async () => {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "step-skill-toggle-"));
  const previous = {
    backend: process.env.STEP_BACKEND,
    root: process.env.STEPCODE_STORAGE_ROOT_DIR,
    home: process.env.HOME,
  };
  try {
    process.env.STEP_BACKEND = "stepcode-local";
    process.env.STEPCODE_STORAGE_ROOT_DIR = root;
    process.env.HOME = root;
    const { createSkillsService } = await import("../src/skills/skillsService.ts");
    const plugin = join(root, "plugins/fixture");
    for (const name of ["one", "one/nested", "two"]) {
      await mkdir(join(plugin, "skills", name, "scripts"), { recursive: true });
      await writeFile(
        join(plugin, "skills", name, "SKILL.md"),
        `---\nname: fixture-${name.replaceAll("/", "-")}\ndescription: fixture\n---\nRun scripts/tool.mjs`,
      );
      await writeFile(join(plugin, "skills", name, "scripts/tool.mjs"), "original");
    }
    const file = join(plugin, "step.plugin.json");
    await writeFile(
      file,
      JSON.stringify({
        id: "fixture",
        version: "1.0.0",
        skills: ["skills", "skills/one/nested/SKILL.md"],
        commands: ["commands"],
      }),
    );
    const service = createSkillsService({ isDesktopRuntime: false });
    const params = { workspacePath: root };
    const before = (await service.list(params)).skills;
    assert.equal(before.length, 3);
    const one = before.find((s) => s.name === "fixture-one")!;
    const signature = await pluginConfigSignature(root);
    const runtimeSkills = async () => {
      if (!process.env.STEP_SKILL_TEST_EXECUTABLE) return null;
      const client = new StepCodeRpcClient({
        command: [process.env.STEP_SKILL_TEST_EXECUTABLE, "--mode", "rpc"],
        cwd: root,
        env: {
          STEPCODE_STORAGE_ROOT_DIR: root,
          STEP_CODING_AGENT_DIR: join(root, "agent"),
          HOME: root,
          USERPROFILE: root,
        },
      });
      try {
        await client.start();
        const response = await client.request({ type: "get_commands" });
        assert.equal(response.success, true);
        return response.data.commands
          .filter((command: { name: string }) => command.name.startsWith("skill:fixture-"))
          .map((command: { name: string }) => command.name)
          .sort();
      } finally {
        await client.stop();
      }
    };
    if (process.env.STEP_SKILL_TEST_EXECUTABLE)
      assert.deepEqual(await runtimeSkills(), [
        "skill:fixture-one",
        "skill:fixture-one-nested",
        "skill:fixture-two",
      ]);
    await service.setEnabled({ ...params, skillId: one.id, enabled: false });
    const manifest = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(manifest.skills, ["skills/one/nested/SKILL.md", "skills/two/SKILL.md"]);
    assert.deepEqual(manifest.commands, ["commands"]);
    assert.notEqual(await pluginConfigSignature(root), signature);
    if (process.env.STEP_SKILL_TEST_EXECUTABLE)
      assert.deepEqual(await runtimeSkills(), ["skill:fixture-one-nested", "skill:fixture-two"]);
    assert.equal((await service.list(params)).skills.find((s) => s.id === one.id)?.enabled, false);
    assert.equal(await readFile(join(plugin, "skills/one/scripts/tool.mjs"), "utf8"), "original");
    for (const skill of before)
      await service.setEnabled({ ...params, skillId: skill.id, enabled: false });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).skills, []);
    if (process.env.STEP_SKILL_TEST_EXECUTABLE) assert.deepEqual(await runtimeSkills(), []);
    await mkdir(join(root, "disabled-plugins"));
    await rename(plugin, join(root, "disabled-plugins/fixture"));
    assert.equal((await service.list(params)).skills.length, 0);
    await rename(join(root, "disabled-plugins/fixture"), plugin);
    assert.ok((await service.list(params)).skills.every((s) => !s.enabled));
    await service.setEnabled({ ...params, skillId: one.id, enabled: true });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).skills, ["skills/one/SKILL.md"]);
    if (process.env.STEP_SKILL_TEST_EXECUTABLE)
      assert.deepEqual(await runtimeSkills(), ["skill:fixture-one"]);
    const reenabled = await readFile(file, "utf8");
    await service.setEnabled({ ...params, skillId: one.id, enabled: true });
    assert.equal(await readFile(file, "utf8"), reenabled);
    await assert.rejects(readFile(join(root, ".zcode/cli/config.json")), { code: "ENOENT" });
    await mkdir(join(root, ".zcode/skills/local"), { recursive: true });
    await writeFile(
      join(root, ".zcode/skills/local/SKILL.md"),
      "---\nname: fixture-one\ndescription: local fixture\n---\nLocal asset",
    );
    await service.setEnabled({ ...params, skillId: one.id, enabled: false });
    const sameNames = (await service.list(params)).skills.filter((s) => s.name === "fixture-one");
    assert.equal(sameNames.length, 2);
    assert.equal(sameNames.find((s) => s.scope === "workspace")?.enabled, true);
    assert.equal(sameNames.find((s) => s.scope === "plugin")?.enabled, false);
    const moved = join(root, "disabled-plugins/fixture");
    await rename(plugin, moved);
    await assert.rejects(
      service.setEnabled({ ...params, skillId: one.id, enabled: true }),
      /Skill not found/,
    );
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally {
    for (const [key, value] of [
      ["STEP_BACKEND", previous.backend],
      ["STEPCODE_STORAGE_ROOT_DIR", previous.root],
      ["HOME", previous.home],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});
