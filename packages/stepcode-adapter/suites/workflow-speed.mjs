import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter, dirname } from "node:path";
import { readWorkflowGuide, WORKFLOW_EXAMPLE } from "../src/workflow/guide.mjs";
import { createWorkflowBridge } from "../src/workflow/bridge.mjs";
import { desktopShellEnvironment } from "../src/desktop-shell.mjs";

test("original workflow guide stays lazy and needs no service initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "step-quick-guide-"));
  const bridge = createWorkflowBridge({
    root,
    session: () => ({ workspace: { workspacePath: root } }),
    rows: () => [],
    changed() {},
    completed() {},
  });
  try {
    const guide = await bridge.request(
      { method: "ReadWorkflowGuide", params: {} },
      { sessionId: "s" },
    );
    assert.match(guide.content, /# Writing dynamic workflows/);
    assert.match(guide.content, /Parallelism comes from/);
    assert.match(guide.integration, /未注册的/);
    await assert.rejects(access(join(root, "workflows")));
    await bridge.hydrate("s");
    await assert.rejects(access(join(root, "workflows")));
    const { engine } = await import("../src/workflow/dependencies.mjs");
    assert.equal(engine.analyzeWorkflowScript(WORKFLOW_EXAMPLE).ok, true);
    assert.equal((await readWorkflowGuide("skill")).content, guide.content);
    await assert.rejects(readWorkflowGuide("missing"), /未知/);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("Windows child PATH chooses installed Git Bash ahead of WSL without changing parent", () => {
  const gitDir = join("D:", "tools", "Git", "cmd"),
    bash = join(gitDir, "..", "bin", "bash.exe");
  const env = {
    Path: [join("C:", "Windows", "System32"), gitDir].join(delimiter),
    TEST: "unchanged",
  };
  const files = new Set([join(gitDir, "git.exe"), bash]);
  const actual = desktopShellEnvironment(env, "win32", (p) => files.has(p));
  assert.equal(actual.bash, bash);
  assert.equal(actual.env.Path.split(delimiter)[0], dirname(bash));
  assert.notEqual(actual.env.Path, env.Path);
  assert.equal(actual.env.TEST, "unchanged");
  assert.deepEqual(desktopShellEnvironment(env, "linux"), { env, bash: null });
  assert.deepEqual(
    desktopShellEnvironment(env, "win32", () => false),
    { env, bash: null },
  );
});
