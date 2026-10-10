import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { httpFixture, projectedClient } from "./provider-wire-fixtures.mjs";
import { prepareProviderRequestOptions } from "../src/provider-request-options.mjs";
import { CHECKPOINT } from "../src/file-checkpoints.mjs";

test("原生 fork 重载扩展后可再次发送，工具快照持久化", { skip: !process.env.STEP_TEST_CLI }, async () => {
  const http = await httpFixture("openai-chat-completions");
  const f = await projectedClient("openai-chat-completions", http.baseUrl);
  const module = pathToFileURL(fileURLToPath(new URL("../src/file-checkpoints.mjs", import.meta.url))).href;
  await writeFile(f.root + "/checkpoints.mjs", `export {registerFileCheckpoints as default} from ${JSON.stringify(module)};`);
  f.client.options.command = f.client.options.command.filter(x => x !== "--no-session");
  f.client.options.command.push("--extension", f.root + "/checkpoints.mjs", "--approval-mode", "auto");
  f.client.options.communicationMode = "required";
  try {
    await f.client.start(); await f.client.setModel(f.providerId, f.modelId);
    async function prompt(text) {
      await prepareProviderRequestOptions(f.client, { providerId: f.providerId, modelId: f.modelId, options: { reasoningLevel: "low" } });
      return f.client.promptAndWait(text, { timeoutMs: 30000 });
    }
    http.set({ kind: "text", text: "one" }); await prompt("one");
    const entries = await f.client.request({ type: "get_entries" });
    const user = entries.data.entries.find(e => e.message?.role === "user");
    const old = (await f.client.getState()).sessionFile;
    const fork = await f.client.request({ type: "fork", entryId: user.id });
    assert.equal(fork.success, true); assert.equal(fork.data.cancelled, false);
    assert.notEqual((await f.client.getState()).sessionFile, old);
    http.set({ kind: "tool", name: "write_file", args: { path: f.root + "/new.txt", content: "checkpoint" }, text: "done" });
    await prompt("write");
    assert.equal(await readFile(f.root + "/new.txt", "utf8"), "checkpoint");
    const after = await f.client.request({ type: "get_entries" });
    const record = after.data.entries.find(e => e.customType === CHECKPOINT && e.data.phase === "after");
    assert.equal(record.data.before.hash, "missing"); assert.equal(Buffer.from(record.data.afterImage.data, "base64").toString(), "checkpoint");
  } finally { await f.client.stop(); await http.close(); }
});
