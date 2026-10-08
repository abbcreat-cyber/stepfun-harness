import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHooksService } from "../src/hooks/hooksService.ts";
import { readStepBuiltinHooks, setStepBuiltinHookEnabled } from "@zcode/shared/node";

test("Step built-in hooks share service/runtime state, preserve concurrent updates and reject corruption", async () => {
  const root = await mkdtemp("D:/Temp/stepfun-harness-tests/hooks-service-");
  const prior = { backend: process.env.STEP_BACKEND, root: process.env.STEPCODE_STORAGE_ROOT_DIR, home: process.env.HOME };
  try {
    process.env.STEP_BACKEND = "stepcode-local"; process.env.STEPCODE_STORAGE_ROOT_DIR = root; process.env.HOME = root;
    const service = createHooksService();
    const initial = await service.loadHooks({ workspacePath: root });
    assert.equal(initial.builtinHooks?.length, 2);
    assert.equal(initial.hooksEnabled, true);
    assert.ok(initial.builtinHooks?.every(h => h.enabled));
    await Promise.all([service.setBuiltinHookEnabled!({ id: "first-principles", enabled: false }), service.setBuiltinHookEnabled!({ id: "opening-explanation", enabled: false })]);
    assert.ok((await readStepBuiltinHooks(root)).every(h => !h.enabled));
    assert.deepEqual((await service.loadHooks({ workspacePath: root })).builtinHooks, await readStepBuiltinHooks(root));
    await service.saveHooks({ workspacePath: root, hooks: initial.hooks });
    assert.ok((await readStepBuiltinHooks(root)).every(h => !h.enabled), "saving command hooks cannot overwrite built-ins");
    await writeFile(join(root, "desktop-hooks.json"), "BROKEN");
    await assert.rejects(service.loadHooks({ workspacePath: root }), /内置钩子/);
    await assert.rejects(setStepBuiltinHookEnabled(root, "opening-explanation", true), /内置钩子/);
    assert.equal(await readFile(join(root, "desktop-hooks.json"), "utf8"), "BROKEN");
    delete process.env.STEP_BACKEND;
    assert.equal((await createHooksService().loadHooks({ workspacePath: root })).builtinHooks, undefined);
  } finally {
    for (const [key, value] of Object.entries({ STEP_BACKEND: prior.backend, STEPCODE_STORAGE_ROOT_DIR: prior.root, HOME: prior.home })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
