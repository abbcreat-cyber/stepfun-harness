import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ownerFixture } from "./provider-wire-owner-fixtures.mjs";
import {
  finalHttp,
  fakeHost,
  hostEnvironment,
  twoModels,
  addUnownedOldTuple,
  boundedWait,
} from "./provider-wire-final-fixtures.mjs";

const options = {
  skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for real Host reverse admission",
  timeout: 100000,
};
const reject = (ack) =>
  assert.ok(ack.error || ["failed", "rejected"].includes(ack.result?.status), JSON.stringify(ack));
const snapshot = (frame) => frame.params?.frame?.payload?.snapshot;

test(
  "installed Step parent router: strict Host gate, queue freeze/resume, scope and actual tuple eligibility",
  options,
  async (t) => {
    const http = await finalHttp();
    const state = {
      identity: "Wire-Final-Host-Identity",
      ready: true,
      allowed: new Set(),
      mode: "ready",
    };
    let old;
    const f = await ownerFixture(t, "openai-chat-completions", {
      http,
      evidenceName: "final-host-router.json",
      workspaceId: () => state.identity,
      environment: (fixture) => hostEnvironment(fixture, state),
      beforeCreate: async (fixture) => {
        await twoModels(fixture);
        old = await addUnownedOldTuple(fixture);
        for (const model of fixture.currentView().models)
          state.allowed.add(`${fixture.providerId}/${model.modelId}`);
        state.allowed.add(`${old.providerId}/${old.modelId}`);
        await fakeHost(fixture.bridge, fixture, state);
      },
    });
    const second = {
      providerId: f.providerId,
      modelId: "unlisted-second-20261008",
      options: { reasoningLevel: "tiny" },
    };
    const registryBefore = JSON.stringify(f.currentView()),
      fileBefore = await readFile(join(f.root, "models.json"), "utf8");
    await t.test("two unknown models in one SDK retain per-model headers and maps", async () => {
      for (const [selection, expected] of [
        [f.choose("enabled"), "A"],
        [second, "B"],
        [f.choose("tiny"), "A"],
      ]) {
        http.set({ name: `model-${expected}`, failures: 0, text: `FINAL_MODEL_${expected}` });
        const result = await f.send(`FINAL_MODEL_${expected}_INPUT`, selection);
        assert.equal(result.final.params.payload.resultType, "success");
        assert.equal(result.requests[0].body.model, selection.modelId);
        assert.equal(result.requests[0].headers["x-owner-model"], expected);
        assert.equal(result.requests[0].body.fixture_model_map, expected);
        assert.equal(result.saved.session.modelSelection.modelId, selection.modelId);
        assert.equal(
          result.saved.session.modelSelection.options.reasoningLevel,
          selection.options.reasoningLevel,
        );
      }
      assert.equal(JSON.stringify(f.currentView()), registryBefore);
      assert.equal(
        await readFile(join(f.root, "models.json"), "utf8"),
        fileBefore,
        "SDK model switching cannot overwrite Registry projection",
      );
      f.records.push({ name: "same SDK two-model isolation", passed: true });
    });
    await t.test(
      "accepted busy queue freezes without HTTP until fresh Host gate resumes once",
      async () => {
        const before = http.requests.length,
          after = f.bridge.frames.length;
        http.set({ name: "host-busy", failures: 0, text: "FINAL_HOST_BUSY_" + "x".repeat(6000) });
        const active = await f.command("sendText", {
          text: "FINAL_HOST_BUSY_INPUT",
          modelSelection: f.choose("tiny"),
        });
        assert.equal(active.result?.status, "accepted", JSON.stringify(active));
        await boundedWait(() => http.requests.length > before, "active Host-authorized HTTP");
        const queued = await f.command("sendText", {
          text: "FINAL_HOST_QUEUE_INPUT",
          modelSelection: second,
          requestedDelivery: "queue",
        });
        assert.equal(queued.result?.result?.delivery, "queue", JSON.stringify(queued));
        state.ready = false;
        await f.completed(after);
        await f.bridge.waitFor(
          (frame) =>
            snapshot(frame)?.queue?.autoDrain === false &&
            snapshot(frame)?.queue?.pauseReason === "error",
          { timeoutMs: 30000, label: "Host denied queue frozen" },
        );
        const frozen = await f.persisted(),
          entry = frozen.queueEntries.find((item) => item.text === "FINAL_HOST_QUEUE_INPUT");
        assert.equal(entry?.state, "queued");
        assert.equal(http.requests.length, before + 1);
        assert.ok(state.calls.some((call) => call.readyAtCall === false));
        state.ready = true;
        http.set({ name: "host-resumed", failures: 0, text: "FINAL_HOST_QUEUE_DONE" });
        const resumeAfter = f.bridge.frames.length;
        const resume = await f.command("setAutoDrain", { autoDrain: true });
        assert.equal(resume.result?.status, "accepted", JSON.stringify(resume));
        const final = await f.completed(resumeAfter);
        assert.equal(final.params.payload.resultType, "success");
        await f.bridge.waitFor(
          (frame) =>
            snapshot(frame)?.rows?.window?.some(
              (row) =>
                row.kind === "assistantText" &&
                row.text === "FINAL_HOST_QUEUE_DONE" &&
                row.state === "complete",
            ),
          { label: "resumed native V4 completion" },
        );
        assert.equal(
          http.requests.length,
          before + 2,
          "resume may execute the pending message exactly once",
        );
        assert.equal(http.requests.at(-1).body.model, second.modelId);
        assert.equal(http.requests.at(-1).headers["x-owner-model"], "B");
        assert.ok(JSON.stringify(http.requests.at(-1).body).includes("FINAL_MODEL_A_INPUT"));
        f.records.push({
          name: "fresh gate queue freeze and explicit resume",
          passed: true,
          queuedSource: queued.result.commandId,
        });
      },
    );
    await t.test(
      "missing public Host handler and mismatched workspace fail before HTTP",
      async () => {
        let count = http.requests.length;
        state.mode = "missing";
        reject(
          await f.command("sendText", {
            text: "FINAL_MISSING_HOST",
            modelSelection: f.choose("enabled"),
          }),
        );
        assert.equal(http.requests.length, count);
        state.mode = "ready";
        const wrongPath = join(f.root, "mismatched-workspace");
        const callsBeforeMismatch = state.calls.length;
        const mismatched = await f.command("createSession", {
          workspaceId: wrongPath,
          config: { modelSelection: f.choose("enabled") },
        });
        reject(mismatched);
        assert.match(mismatched.error?.message ?? "", /工作区.*不匹配|workspace.*mismatch/i);
        assert.equal(http.requests.length, count);
        assert.equal(
          state.calls.length,
          callsBeforeMismatch,
          "trusted scope rejects mismatch before the reverse Host port",
        );
        http.set({ name: "scope-recovered", failures: 0, text: "FINAL_SCOPE_RECOVERED" });
        const result = await f.send("FINAL_SCOPE_RECOVERY_INPUT", second);
        assert.equal(result.final.params.payload.resultType, "success");
        assert.ok(JSON.stringify(result.requests[0].body).includes("FINAL_HOST_QUEUE_INPUT"));
        assert.ok(
          state.calls.some(
            (call) =>
              call.params.workspace.workspacePath === f.root &&
              call.params.workspace.workspaceIdentity === state.identity &&
              call.params.workspace.workspaceKey === state.identity,
          ),
        );
        f.records.push({ name: "strict local workspace and identity boundary", passed: true });
      },
    );
    await t.test(
      "Host rejects deleted unowned old tuple, valid new tuple restores native history",
      async () => {
        http.set({ name: "old-warm", failures: 0, text: "FINAL_OLD_WARM" });
        const warm = await f.send("FINAL_OLD_WARM_INPUT", old);
        assert.equal(warm.requests[0].body.model, old.modelId);
        state.allowed.delete(`${old.providerId}/${old.modelId}`);
        const count = http.requests.length;
        assert.ok(
          JSON.parse(await readFile(join(f.root, "models.json"), "utf8")).providers[old.providerId],
        );
        reject(await f.command("sendText", { text: "FINAL_REMOVED_TUPLE" }));
        assert.equal(http.requests.length, count);
        http.set({ name: "valid-tuple-recovered", failures: 0, text: "FINAL_VALID_TUPLE_DONE" });
        const good = await f.send("FINAL_VALID_TUPLE_INPUT", second);
        assert.equal(good.final.params.payload.resultType, "success");
        assert.equal(good.requests[0].body.model, second.modelId);
        assert.ok(JSON.stringify(good.requests[0].body).includes("FINAL_OLD_WARM_INPUT"));
        assert.ok(JSON.stringify(good.requests[0].body).includes("FINAL_MODEL_A_INPUT"));
        assert.equal(good.saved.session.modelSelection.modelId, second.modelId);
        assert.ok(
          state.calls.some(
            (call) =>
              call.params.selection?.providerId === old.providerId &&
              call.params.selection?.modelId === old.modelId,
          ),
        );
        f.records.push({ name: "unmanaged SDK tuple is not Registry eligibility", passed: true });
      },
    );
    assert.deepEqual(state.errors, []);
    assert.deepEqual(http.errors, []);
    f.records.push({
      name: "actual reverse frames parsed by shared strict contracts",
      passed: true,
      calls: state.calls,
    });
  },
);
