import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionsIndex } from "../src/bridge/sessions-index.mjs";
import { createSessionMethods } from "../src/bridge/methods-session.mjs";
import { makeSessionSummary } from "../src/wire-shapes.mjs";

test("索引先按水位筛选再读正文，完整重同步与空草稿校正保持", async () => {
  const root = await mkdtemp(join(tmpdir(), "index-incremental-"));
  const frames = [],
    reads = [];
  const workspace = "ssh:CaseSensitive",
    topic = `sessions-index/${workspace}`;
  const summary = (sessionId, lastActivityAt) =>
    makeSessionSummary({
      sessionId,
      workspaceId: workspace,
      title: sessionId,
      phase: "completedSuccess",
      createdAt: 1,
      lastActivityAt,
    });
  const summaries = [summary("a", 1), summary("b", 2), summary("empty", 3)];
  const ctx = {
    STATE_DIR: root,
    STATE_FILE: join(root, "sessions-index.json"),
    primarySession: null,
    conversationSeq: 0,
    logEpoch: "test",
    v4Subscriptions: new Map([[topic, "sub"]]),
    readConversation(id) {
      reads.push(id);
      return { rows: id === "empty" ? [] : [{}], session: { mode: "plan", modelSelection: { providerId: "saved-provider", modelId: "saved-model" } } };
    },
    notify(_method, frame) {
      frames.push(frame);
    },
  };
  const oldWatch = process.env.STEPCODE_BRIDGE_STATE_WATCH;
  process.env.STEPCODE_BRIDGE_STATE_WATCH = "0";
  const index = createSessionsIndex(ctx);
  if (oldWatch === undefined) delete process.env.STEPCODE_BRIDGE_STATE_WATCH;
  else process.env.STEPCODE_BRIDGE_STATE_WATCH = oldWatch;
  const save = () =>
    writeFile(
      ctx.STATE_FILE,
      JSON.stringify({
        version: 1,
        workspaces: {
          [workspace]: summaries,
          // legacy bucket 的重复项即使更新时间更大，也不能压过 exact bucket。
          [workspace.toLowerCase()]: [
            { ...summary("a", 999), title: "legacy" },
            { ...summary("other-tenant", 999), workspaceId: workspace.toLowerCase() },
          ],
        },
      }),
    );
  const payload = () => frames.at(-1).frame.payload;
  try {
    await save();
    index.broadcastSessionsIndexSnapshot(topic);
    assert.equal(frames.at(-1).deliveryKind, "initial");
    assert.deepEqual(reads, ["a", "b", "empty"]);
    assert.equal(payload().snapshot.sessions.find((s) => s.sessionId === "empty").phase, "draft");
    const firstSeq = frames.at(-1).frame.toSeq;
    reads.length = 0;
    index.pushPersistedUpserts();
    index.pushPersistedUpserts();
    assert.deepEqual(reads, []);
    assert.equal(frames.length, 1);

    summaries[1] = { ...summaries[1], lastActivityAt: 4, title: "renamed" };
    await save();
    index.pushPersistedUpserts();
    assert.deepEqual(reads, ["b"]);
    assert.deepEqual(
      payload().deltas.map((d) => d.session.title),
      ["renamed"],
    );
    assert.equal(frames.at(-1).deliveryKind, "online");
    assert.equal(frames.at(-1).frame.fromSeq, firstSeq);
    assert.ok(frames.at(-1).frame.toSeq > firstSeq);
    reads.length = 0;
    index.pushPersistedUpserts();
    assert.deepEqual(reads, []);
    assert.equal(frames.length, 2);

    summaries[0].lastActivityAt = 5;
    summaries[2].lastActivityAt = 6;
    await save();
    await writeFile(
      join(root, "deleted-sessions.json"),
      JSON.stringify({ version: 1, sessionIds: ["a"] }),
    );
    index.pushPersistedUpserts();
    assert.deepEqual(reads, ["empty"]);
    assert.equal(payload().deltas[0].session.phase, "draft");
    reads.length = 0;
    index.broadcastSessionsIndexSnapshot(topic, "recovery");
    assert.equal(frames.at(-1).deliveryKind, "recovery");
    assert.deepEqual(reads, ["b", "empty"]);
    Object.assign(ctx, index);
    const methods = createSessionMethods(ctx);
    reads.length = 0;
    const selected = methods["session/list"]({
      workspace: { workspacePath: root, workspaceIdentity: workspace },
      sessionIds: ["b", "b", "other-tenant", "missing", 42, ""],
    });
    assert.equal(selected.sessions[0].mode, "plan");
    assert.deepEqual(selected.sessions[0].model, { providerId: "saved-provider", modelId: "saved-model" });
    assert.deepEqual(
      selected.sessions.map((s) => s.sessionId),
      ["b"],
    );
    assert.deepEqual(reads, ["b"]);
    reads.length = 0;
    assert.deepEqual(
      methods["session/list"]({
        workspace: { workspacePath: root, workspaceIdentity: workspace },
        sessionIds: [],
      }).sessions,
      [],
    );
    assert.deepEqual(reads, []);
    assert.deepEqual(
      payload().snapshot.sessions.map((s) => s.sessionId),
      ["b", "empty"],
    );
    reads.length = 0;
    assert.deepEqual(
      index.persistedSummariesFor(workspace, true).map((s) => s.sessionId),
      ["b", "empty"],
    );
    assert.deepEqual(reads, ["b", "empty"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
