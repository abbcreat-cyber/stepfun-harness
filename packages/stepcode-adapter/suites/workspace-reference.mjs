import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unwatchFile } from "node:fs";
import { resolveSessionWorkspace } from "../src/bridge/model-admission.mjs";
import { createSessionLifecycle } from "../src/bridge/session-lifecycle.mjs";
import { createSessionsIndex } from "../src/bridge/sessions-index.mjs";
import { launchBridge, waitForExit } from "./helpers.mjs";

const identity = "LogicalCaseKey";

async function fixture(t) {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "workspace-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ref = { workspacePath: root, workspaceKey: identity, workspaceIdentity: identity, remoteSessionId: "trusted-remote-session" };
  return { root, ref, ctx: { options: { stepCwd: root, stepEnv: { STEPCODE_HOST_WORKSPACE_REF: JSON.stringify(ref) } } } };
}

test("workspace: V4 logical id uses trusted physical path and original identity/remote binding", async t => {
  const { ctx, ref } = await fixture(t);
  assert.deepEqual(await resolveSessionWorkspace(ctx, { workspaceId: identity }), ref);
  assert.deepEqual(await resolveSessionWorkspace(ctx, { workspace: { workspacePath: identity, workspaceKey: identity } }), ref);
  await assert.rejects(resolveSessionWorkspace(ctx, { workspaceId: identity.toLowerCase() }), /身份.*不匹配/);
  await assert.rejects(resolveSessionWorkspace(ctx, { workspace: { ...ref, remoteSessionId: "foreign-session" } }), /远程会话.*不匹配/);
});

test("workspace: restore repairs legacy logical-as-path only after the trusted binding matches", async t => {
  const { ctx, ref } = await fixture(t), saved = { session: { sessionId: "saved", workspace: { workspacePath: identity, workspaceKey: identity } }, rows: [] };
  let persisted;
  Object.assign(ctx, { readConversation: () => saved, turnBusy: false, ledger: { restoreQueue() {} }, persistConversation: () => { persisted = ctx.primarySession.workspace; },
    runWithPreparedClient: async (options, operation) => { assert.deepEqual(options.workspace, ref); return operation({}); } });
  await createSessionLifecycle(ctx).restoreSession("saved");
  assert.deepEqual(ctx.primarySession.workspace, ref);
  await createSessionLifecycle(ctx).restoreSession("saved"); assert.deepEqual(persisted, ref);
  saved.session.workspace = { workspacePath: "foreign", workspaceKey: "foreign" }; ctx.primarySession = null;
  await assert.rejects(createSessionLifecycle(ctx).restoreSession("saved"), /身份.*不匹配/);
});

test("workspace: identity case stays isolated and legacy lower bucket cannot mix foreign identity", async t => {
  const { root } = await fixture(t), state = join(root, "state.json");
  const ctx = { STATE_DIR: root, STATE_FILE: state, readConversation: () => null, IS_SESSION_WORKER: false };
  const index = createSessionsIndex(ctx);
  t.after(() => unwatchFile(state));
  const summary = (id, workspaceId) => ({ sessionId: id, workspaceId });
  index.persistSessionSummary(identity, summary("upper", identity), true);
  index.persistSessionSummary(identity.toLowerCase(), summary("lower", identity.toLowerCase()), true);
  assert.deepEqual(index.persistedSummariesFor(identity, true).map(item => item.sessionId), ["upper"]);
  assert.deepEqual(index.persistedSummariesFor(identity.toLowerCase(), true).map(item => item.sessionId), ["lower"]);
  await writeFile(state, JSON.stringify({ version: 1, workspaces: { [identity.toLowerCase()]: [summary("legacy-upper", identity), summary("foreign-lower", identity.toLowerCase())] } }));
  assert.deepEqual(index.persistedSummariesFor(identity, true).map(item => item.sessionId), ["legacy-upper"]);
  await writeFile(state, JSON.stringify({ version: 1, workspaces: {
    [identity]: [{ ...summary("same", identity), title: "new-name", lastActivityAt: 2 }],
    [identity.toLowerCase()]: [{ ...summary("same", identity), title: "old-name", lastActivityAt: 1 }, summary("legacy-only", identity)],
  } }));
  const migrated = index.persistedSummariesFor(identity, true);
  assert.equal(migrated.find(item => item.sessionId === "same").title, "new-name");
  assert.equal(migrated.find(item => item.sessionId === "same").lastActivityAt, 2);
  assert.ok(migrated.some(item => item.sessionId === "legacy-only"));
  assert.equal(index.normalizeWorkspaceKey(root.toUpperCase()), index.normalizeWorkspaceKey(root));
});

test("workspace: real router mock backend persists physical path, indexes logical identity, and rejects foreign scope", async t => {
  const { root, ref } = await fixture(t), stateDir = join(root, "bridge-state");
  const b = launchBridge([], { STEPCODE_HOST_MODEL_ADMISSION: "1", STEPCODE_HOST_WORKSPACE_REF: JSON.stringify(ref) }, { stateDir, cwd: root });
  const replied = new Set(), portFrames = [];
  const timer = setInterval(() => {
    for (const frame of b.frames) if (frame.method === "interaction/prepareModelExecution" && !replied.has(frame.id)) {
      replied.add(frame.id); portFrames.push(frame);
      const matching = frame.params.workspace.workspacePath === root && frame.params.workspace.workspaceIdentity === identity && frame.params.workspace.remoteSessionId === ref.remoteSessionId;
      b.send({ id: frame.id, result: matching ? { ready: true } : { ready: false, error: { message: "fixture scope mismatch" } } });
    }
  }, 5);
  try {
    b.send({ id: 1, method: "v4/command", params: { type: "createSession", commandId: "create", sessionId: "logical-session", payload: { workspaceId: identity } } });
    const created = await b.waitFor(frame => frame.id === 1); assert.equal(created.error, undefined);
    const saved = JSON.parse(await readFile(join(stateDir, "conversations", "logical-session.json"), "utf8"));
    assert.deepEqual(saved.session.workspace, ref); assert.ok(portFrames.length >= 1);
    b.send({ id: 2, method: "session/list", params: { workspace: ref } });
    const listed = await b.waitFor(frame => frame.id === 2); assert.ok(listed.result.sessions.some(session => session.sessionId === "logical-session"));
    b.send({ id: 3, method: "v4/command", params: { type: "createSession", commandId: "foreign", sessionId: "foreign-session", payload: { workspaceId: identity.toLowerCase() } } });
    const foreign = await b.waitFor(frame => frame.id === 3); assert.match(foreign.error.message, /身份.*不匹配/);
  } finally { clearInterval(timer); b.child.stdin.end(); await waitForExit(b.child); }
});
