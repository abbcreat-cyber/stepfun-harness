import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "../src/bridge/conversation-store.mjs";
import { SessionStatistics } from "../src/session-statistics.mjs";

for (const mode of ["cold", "history", "warm", "missing", "corrupt"]) {
  test(`统计恢复 ${mode} 复用正文且保留补账去重`, async () => {
    const root = await mkdtemp(join(tmpdir(), "statistics-hydration-"));
    const original = fs.readFileSync;
    let reads = 0;
    const message = (n) => ({
      role: "assistant",
      content: [{ type: "text", text: `reply-${n}` }],
      usage: { input: 10, output: n },
    });
    const saved = new SessionStatistics();
    saved.seed([{ type: "message", id: "a", message: message(1) }]);
    const native = join(root, "native.jsonl");
    const ctx = {
      STATE_DIR: root,
      IS_SESSION_WORKER: true,
      primarySession: { sessionId: "test", stepSessionFile: native },
    };
    const store = createConversationStore(ctx),
      file = store.conversationFile("test");
    try {
      fs.mkdirSync(join(root, "conversations"));
      if (mode !== "missing")
        await writeFile(
          file,
          mode === "corrupt"
            ? "{"
            : JSON.stringify({ session: ctx.primarySession, statistics: saved.serialize() }),
        );
      if (mode === "history") ctx.primarySession = null;
      await writeFile(
        native,
        [
          { type: "message", id: "a", message: message(1) },
          { type: "message", id: "b", message: message(2) },
        ]
          .map(JSON.stringify)
          .join("\n") + '\n{"partial":',
      );
      const warm = mode === "warm" ? store.sessionStatistics("test") : null;
      if (warm) warm.addMessage(message(4));
      fs.readFileSync = (path, ...args) => {
        if (String(path) === file) reads++;
        return original(path, ...args);
      };
      syncBuiltinESMExports();
      await Promise.all([store.hydrateStatistics("test"), store.hydrateStatistics("test")]);
      assert.equal(reads, 1);
      const stats = store.sessionStatistics("test");
      assert.equal(stats.totals.steps, warm ? 3 : 2);
      assert.equal(stats.totals.outputTokens, warm ? 7 : 3);
      if (warm) assert.equal(stats, warm);
      await store.hydrateStatistics("test");
      assert.equal(reads, 1);
      assert.equal(stats.addMessage(message(2)), false);
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}
