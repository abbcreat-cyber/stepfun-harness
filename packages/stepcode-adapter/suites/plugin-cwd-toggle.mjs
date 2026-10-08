import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStepPluginHandlers } from "../src/plugins.mjs";
import {
  pluginConfigSignature,
  ensureOfficialStepPlugins,
  OFFICIAL_PLUGIN_NAMES,
} from "../src/official-plugins.mjs";
import { StepCodeRpcClient } from "../src/rpc-client.mjs";

test("plugin toggle retains occupied runtime cwd, config and skill selection while native discovery changes", async () => {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "step-plugin-cwd-"));
  const plugin = join(root, "plugins/fixture"),
    file = join(plugin, "step.plugin.json");
  await mkdir(join(plugin, "skills/fixture"), { recursive: true });
  await mkdir(join(plugin, ".zcode-plugin"));
  await writeFile(
    join(plugin, ".zcode-plugin/plugin.json"),
    JSON.stringify({ name: "fixture", skills: "skills" }),
  );
  await writeFile(
    join(plugin, "skills/fixture/SKILL.md"),
    "---\nname: cwd-fixture\ndescription: fixture only\n---\nFixture",
  );
  const manifest = {
    id: "fixture",
    version: "1.0.0",
    skills: ["skills/fixture/SKILL.md"],
    stepSkillSelection: { roots: ["skills"], disabled: ["skills/other/SKILL.md"] },
  };
  await writeFile(file, JSON.stringify(manifest));
  await writeFile(join(plugin, "step-user-config.json"), JSON.stringify({ fixture: "preserved" }));
  const holder = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { cwd: plugin, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  await once(holder.stdout, "data");
  const handlers = createStepPluginHandlers(root, { officialSource: join(root, "empty") });
  const discover = async () => {
    if (!process.env.STEP_SKILL_TEST_EXECUTABLE) return;
    const client = new StepCodeRpcClient({
      command: [process.env.STEP_SKILL_TEST_EXECUTABLE, "--mode", "rpc"],
      cwd: root,
      env: {
        HOME: root,
        USERPROFILE: root,
        STEPCODE_STORAGE_ROOT_DIR: root,
        STEP_CODING_AGENT_DIR: join(root, "agent"),
      },
    });
    try {
      await client.start();
      return (await client.getCommands()).some((c) => c.name === "skill:cwd-fixture");
    } finally {
      await client.stop();
    }
  };
  try {
    if (process.platform === "win32")
      await assert.rejects(rename(plugin, `${plugin}-moved`), { code: "EBUSY" });
    if (process.env.STEP_SKILL_TEST_EXECUTABLE) assert.equal(await discover(), true);
    const signature = await pluginConfigSignature(root);
    const disabled = await handlers["plugins/setEnabled"]({
      pluginId: "fixture@stepcode",
      enabled: false,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.plugin.rootPath, plugin);
    assert.notEqual(await pluginConfigSignature(root), signature);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal(holder.exitCode, null);
    assert.equal(holder.killed, false);
    if (process.env.STEP_SKILL_TEST_EXECUTABLE) assert.equal(await discover(), false);
    const enabled = await handlers["plugins/setEnabled"]({
      pluginId: "fixture@stepcode",
      enabled: true,
    });
    assert.equal(enabled.enabled, true);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), manifest);
    assert.deepEqual(enabled.plugin.configuredOptions, { fixture: "preserved" });
    if (process.env.STEP_SKILL_TEST_EXECUTABLE) assert.equal(await discover(), true);
    assert.equal(holder.exitCode, null);
    await mkdir(join(plugin, ".claude-plugin"));
    await writeFile(join(plugin, ".claude-plugin/plugin.json"), '{"name":"fixture"}');
    await assert.rejects(
      handlers["plugins/setEnabled"]({ pluginId: "fixture@stepcode", enabled: false }),
      /Claude/,
    );
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), manifest);
  } finally {
    holder.kill();
    await once(holder, "exit");
  }
});

test("legacy disabled directories migrate once and unavailable active declarations retire with occupied cwd", async () => {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "step-plugin-migrate-"));
  const legacy = join(root, "disabled-plugins/pdf");
  await mkdir(legacy, { recursive: true });
  await writeFile(
    join(legacy, "step.plugin.json"),
    JSON.stringify({
      id: "pdf",
      stepOfficial: true,
      skills: [],
      stepSkillSelection: { roots: ["skills"], disabled: ["skills/pdf/SKILL.md"] },
      mcpServers: { fixture: { args: ["--plugin-root", legacy] } },
    }),
  );
  await writeFile(join(legacy, "step-user-config.json"), '{"value":"preserved"}');
  const handlers = createStepPluginHandlers(root, { officialSource: join(root, "empty") });
  const enabled = await handlers["plugins/setEnabled"]({
    pluginId: "pdf@zcode-plugins-official",
    enabled: true,
  });
  const active = join(root, "plugins/pdf");
  assert.equal(enabled.plugin.rootPath, active);
  const manifest = JSON.parse(await readFile(join(active, "step.plugin.json"), "utf8"));
  assert.equal(manifest.mcpServers.fixture.args[1], active);
  assert.deepEqual(manifest.stepSkillSelection.disabled, ["skills/pdf/SKILL.md"]);
  await handlers["plugins/setEnabled"]({ pluginId: "pdf@zcode-plugins-official", enabled: false });
  assert.equal(
    (await handlers["plugins/list"]()).plugins.find((p) => p.id === "pdf@zcode-plugins-official")
      .rootPath,
    active,
  );
  assert.equal(
    await readFile(join(active, "step-user-config.json"), "utf8"),
    '{"value":"preserved"}',
  );

  const source = join(root, "fixture-source"),
    hidden = join(root, "plugins/image-search");
  await mkdir(source);
  await writeFile(
    join(source, "catalog.json"),
    JSON.stringify({ format: 1, plugins: OFFICIAL_PLUGIN_NAMES.map((name) => ({ name })) }),
  );
  for (const name of OFFICIAL_PLUGIN_NAMES.filter((name) => name !== "pdf")) {
    const directory = name === "image-search" ? hidden : join(root, "disabled-plugins", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "step.plugin.json"),
      JSON.stringify({ id: name, stepOfficial: true }),
    );
  }
  const userPlugin = join(root, "plugins/plugin-creator");
  await mkdir(userPlugin, { recursive: true });
  await writeFile(join(userPlugin, "step.plugin.json"), '{"id":"plugin-creator","skills":[]}');
  const holder = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { cwd: hidden, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  await once(holder.stdout, "data");
  try {
    await ensureOfficialStepPlugins(root, source);
    assert.equal(
      await readFile(join(userPlugin, "step.plugin.json"), "utf8"),
      '{"id":"plugin-creator","skills":[]}',
    );
    await assert.rejects(readFile(join(hidden, "step.plugin.json")), { code: "ENOENT" });
    assert.equal(
      JSON.parse(await readFile(join(hidden, "step.plugin.disabled.json"), "utf8")).id,
      "image-search",
    );
    assert.equal(holder.exitCode, null);
    assert.ok(
      !(await handlers["plugins/list"]()).plugins.some((p) => p.id.startsWith("image-search@")),
    );
    assert.equal(
      (await handlers["plugins/list"]()).plugins.find((p) => p.id === "pdf@zcode-plugins-official")
        .enabled,
      false,
    );
  } finally {
    holder.kill();
    await once(holder, "exit");
  }
});
