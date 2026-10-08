import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { protocols, markerText, readTool, hasToolResult } from "./provider-wire-fixtures.mjs";
import { ownerFixture, assertMapped } from "./provider-wire-owner-fixtures.mjs";

const options = {
  skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for real bridge owner HTTP mapping",
  timeout: 120000,
};
async function waitFor(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function success(result, expected) {
  assert.equal(result.final.params.payload.resultType, "success", JSON.stringify(result.final));
  assert.ok(
    result.saved.rows.some((row) => row.kind === "assistantText" && row.text?.includes(expected)),
  );
}

for (const protocol of protocols)
  test(`installed Step bridge owner mapped options: ${protocol}`, options, async (t) => {
    const f = await ownerFixture(t, protocol);
    async function check(name, run) {
      await t.test(name, async () => {
        try {
          const result = await run();
          f.records.push({ name, passed: true, result });
        } catch (error) {
          f.records.push({ name, passed: false, error: error.message });
          throw error;
        }
      });
    }
    await check(
      "ordinary send maps raw enabled value and model output limit on actual HTTP",
      async () => {
        f.http.set({ kind: "owner-text", text: "OWNER_BASE_FINAL", newline: "\n" });
        const result = await f.send("OWNER_BASE_INPUT");
        success(result, "OWNER_BASE_FINAL");
        assert.equal(result.requests.length, 1);
        assertMapped(protocol, result.requests[0], "enabled");
        assert.equal(result.saved.session.modelSelection.options.reasoningLevel, "enabled");
        return {
          request: result.requests[0],
          selection: result.saved.session.modelSelection,
          stepSessionFile: result.saved.session.stepSessionFile,
        };
      },
    );
    await check(
      "tool continuation keeps arbitrary raw tiny selection and native marker",
      async () => {
        const tool = readTool(f.http.requests[0].body, f.marker);
        f.http.set({ kind: "tool", ...tool, text: "OWNER_TOOL_FINAL", newline: "\n" });
        const result = await f.send("OWNER_TOOL_INPUT", f.choose("tiny"));
        success(result, "OWNER_TOOL_FINAL");
        assert.equal(result.requests.length, 2);
        for (const request of result.requests) assertMapped(protocol, request, "tiny");
        assert.ok(hasToolResult(protocol, result.requests[1].body));
        assert.ok(JSON.stringify(result.requests[1].body).includes(markerText));
        assert.equal(result.saved.session.modelSelection.options.reasoningLevel, "tiny");
        assert.ok(
          result.saved.rows.some(
            (row) => row.kind === "toolCall" && JSON.stringify(row).includes(markerText),
          ),
        );
        return {
          selection: result.saved.session.modelSelection,
          tool: tool.name,
          nativeToolResult: true,
        };
      },
    );
    if (protocol !== protocols[0]) return;
    await check(
      "ordinary same-model continuation refreshes changed key/parameter and preserves native history",
      async () => {
        const before = await f.persisted();
        await f.sync((view) => {
          view.config.access.apiKey = "sk-fixture-owner-rotated";
          view.models[0].config.native.samplingParams.fixture_epoch = "after";
        });
        f.http.set({ kind: "owner-refresh", text: "OWNER_REFRESH_FINAL", newline: "\n" });
        const result = await f.send("OWNER_REFRESH_INPUT");
        success(result, "OWNER_REFRESH_FINAL");
        const request = result.requests[0];
        assert.equal(request.headers.authorization, "Bearer sk-fixture-owner-rotated");
        assert.equal(request.body.fixture_epoch, "after");
        assertMapped(protocol, request, "tiny");
        assert.ok(JSON.stringify(request.body).includes("OWNER_BASE_INPUT"));
        assert.ok(JSON.stringify(request.body).includes("OWNER_TOOL_FINAL"));
        assert.equal(result.saved.session.stepSessionFile, before.session.stepSessionFile);
        assert.equal(result.saved.session.modelSelection.options.reasoningLevel, "tiny");
        return {
          historyPreserved: true,
          selection: result.saved.session.modelSelection,
          keyRotated: true,
        };
      },
    );
    await check(
      "busy managed queue stores raw mapped selection and applies it at idle execution",
      async () => {
        const start = f.bridge.frames.length,
          before = f.http.requests.length;
        f.http.set({
          kind: "owner-busy",
          text: "OWNER_BUSY_FINAL_" + "x".repeat(4000),
          newline: "\n",
        });
        const busy = await f.command("sendText", {
          text: "OWNER_BUSY_INPUT",
          modelSelection: f.choose("tiny"),
        });
        assert.equal(busy.result?.status, "accepted", JSON.stringify(busy));
        await waitFor(() => f.http.requests.length > before, "busy owner HTTP");
        const queued = await f.command("sendText", {
          text: "OWNER_QUEUED_INPUT",
          modelSelection: f.choose("disabled"),
          requestedDelivery: "queue",
        });
        assert.equal(queued.result?.status, "accepted", JSON.stringify(queued));
        assert.equal(queued.result.result.delivery, "queue");
        const pending = await f.persisted();
        assert.ok(
          pending.queueEntries.some(
            (entry) =>
              entry.text === "OWNER_QUEUED_INPUT" &&
              entry.modelSelection.options.reasoningLevel === "disabled",
          ),
        );
        f.http.set({ kind: "owner-queued", text: "OWNER_QUEUED_FINAL", newline: "\n" });
        await f.completed(start);
        await f.bridge.waitFor(
          (frame) =>
            f.bridge.frames.indexOf(frame) >= start &&
            frame.params?.frame?.payload?.snapshot?.rows?.window?.some(
              (row) =>
                row.kind === "assistantText" &&
                row.text?.includes("OWNER_QUEUED_FINAL") &&
                row.state !== "streaming",
            ),
          { timeoutMs: 30000, label: "queued mapped native response" },
        );
        await f.bridge.waitFor(
          (frame) =>
            f.bridge.frames.indexOf(frame) >= start &&
            frame.params?.type === "turn.completed" &&
            frame.params?.payload?.response?.includes("OWNER_QUEUED_FINAL"),
          { label: "queued native terminal" },
        );
        const requests = f.http.requests.slice(before);
        assert.equal(requests.length, 2);
        assertMapped(protocol, requests[0], "tiny");
        assertMapped(protocol, requests[1], "disabled");
        const saved = await f.persisted();
        assert.equal(saved.session.modelSelection.options.reasoningLevel, "disabled");
        assert.ok(JSON.stringify(requests[1].body).includes("OWNER_REFRESH_FINAL"));
        return {
          queuedSelection: pending.queueEntries.find((entry) => entry.text === "OWNER_QUEUED_INPUT")
            .modelSelection,
          finalSelection: saved.session.modelSelection,
        };
      },
    );
    await check(
      "invalid mapped value rejects before HTTP then valid explicit options continue original history",
      async () => {
        const count = f.http.requests.length;
        const bad = await f.command("sendText", {
          text: "OWNER_BAD_VALUE",
          modelSelection: f.choose("undeclared-value"),
        });
        assert.ok(
          bad.error || bad.result?.status === "rejected" || bad.result?.status === "failed",
          JSON.stringify(bad),
        );
        assert.equal(f.http.requests.length, count);
        f.http.set({ kind: "owner-recovery", text: "OWNER_RECOVERED_FINAL", newline: "\n" });
        const result = await f.send("OWNER_RECOVERY_INPUT", f.choose("enabled"));
        success(result, "OWNER_RECOVERED_FINAL");
        assertMapped(protocol, result.requests[0], "enabled");
        assert.ok(JSON.stringify(result.requests[0].body).includes("OWNER_BASE_INPUT"));
        assert.ok(JSON.stringify(result.requests[0].body).includes("OWNER_QUEUED_INPUT"));
        assert.equal(result.saved.session.modelSelection.options.reasoningLevel, "enabled");
        return { rejected: bad, recoverySelection: result.saved.session.modelSelection };
      },
    );
    await check(
      "invalid protected-field map yields real failed turn with zero HTTP then corrected config keeps history",
      async () => {
        const count = f.http.requests.length,
          originalMap = f.registryView.models[0].config.optionSpecs.reasoningLevel.map;
        await f.sync((view) => {
          view.models[0].config.optionSpecs.reasoningLevel.map = '{"model":"illegal-map-target"}';
        });
        const bad = await f.send("OWNER_BAD_MAP_INPUT", f.choose("enabled"));
        assert.equal(
          bad.final.params.payload.resultType,
          "error_during_execution",
          JSON.stringify(bad.final),
        );
        assert.ok(
          bad.saved.rows.some((row) => row.kind === "turnHeader" && row.state === "failed"),
        );
        assert.equal(f.http.requests.length, count);
        await f.sync((view) => {
          view.models[0].config.optionSpecs.reasoningLevel.map = originalMap;
        });
        f.http.set({ kind: "owner-fixed-map", text: "OWNER_FIXED_MAP_FINAL", newline: "\n" });
        const result = await f.send("OWNER_FIXED_MAP_INPUT", f.choose("tiny"));
        success(result, "OWNER_FIXED_MAP_FINAL");
        assertMapped(protocol, result.requests[0], "tiny");
        assert.ok(JSON.stringify(result.requests[0].body).includes("OWNER_BASE_INPUT"));
        assert.ok(JSON.stringify(result.requests[0].body).includes("OWNER_RECOVERY_INPUT"));
        assert.ok(
          (await readFile(result.saved.session.stepSessionFile, "utf8")).includes(
            "OWNER_BASE_INPUT",
          ),
        );
        return {
          failedTurn: true,
          zeroBadHttp: true,
          restoredSelection: result.saved.session.modelSelection,
        };
      },
    );
  });
