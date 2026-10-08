import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startEmbeddedBrowserRelay } from "../src/embedded-browser-relay.mjs";

test(
  "official browser relay rejects old turn arriving after a slow body and preserves current turn",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(
      join(fileURLToPath(new URL("../../../", import.meta.url)), ".cancel-relay-test-"),
    );
    await mkdir(join(root, "plugins/browser-use"), { recursive: true });
    await writeFile(join(root, "plugins/browser-use/step.plugin.json"), "{}");
    let context = { sessionId: "session", turnId: "t1" };
    const calls = [];
    const relay = await startEmbeddedBrowserRelay({
      directory: join(root, "browser-bridges"),
      getContext: () => context,
      requestHost: async (method, params) => {
        calls.push({ method, params });
        return { ok: true, browsers: [] };
      },
    });
    t.after(async () => {
      await relay.close();
      await rm(root, { recursive: true, force: true });
    });
    await relay.bindPid(321);
    const info = JSON.parse(await readFile(join(root, "browser-bridges/321.json"), "utf8"));
    const url = info.endpoint.replace(/\/execute$/, "/official-plugin");
    const command = (turnId, method = "browserExecute") => ({
      method,
      params: {
        sessionId: "session",
        turnId,
        browserId: "iab",
        browserGeneration: 1,
        command: { method: "snapshot" },
      },
    });
    const slow = httpRequest(url, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}` },
    });
    const response = new Promise((resolve, reject) => {
      slow.on("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      slow.on("error", reject);
    });
    slow.write('{"method":');
    await delay(50);
    context = { ...context, turnId: "t2" };
    slow.end(JSON.stringify(command("t1")).slice('{"method":'.length));
    assert.equal(await response, 400);
    assert.equal(calls.length, 0);
    for (const method of ["browserList", "browserExecute"]) {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${info.token}` },
        body: JSON.stringify(command("t2", method)),
      });
      assert.equal(res.status, 200);
      assert.equal(calls.at(-1).params.turnId, "t2");
    }
    context = { sessionId: "session" };
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${info.token}` },
          body: JSON.stringify(command("t2")),
        })
      ).status,
      400,
    );
    assert.equal(calls.length, 2);
  },
);
