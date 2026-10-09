import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  protocols,
  markerText,
  httpFixture,
  projectedClient,
  assistant,
  messageText,
  readTool,
  hasToolResult,
} from "./provider-wire-fixtures.mjs";

const options = {
  skip:
    !process.env.STEP_TEST_CLI &&
    "Set STEP_TEST_CLI; malformed tool JSON must be tested against the installed runtime",
  timeout: 45000,
};
for (const protocol of protocols)
  test(`installed Step tool JSON integrity: ${protocol}`, options, async (t) => {
    const http = await httpFixture(protocol);
    t.after(() => http.close());
    const fixture = await projectedClient(protocol, http.baseUrl);
    const { client, root, marker, providerId, modelId } = fixture;
    const evidence = { protocol, cli: process.env.STEP_TEST_CLI, document: fixture.document };
    t.after(async () => {
      await client.stop();
      if (process.env.STEP_WIRE_EVIDENCE_DIR) {
        await mkdir(process.env.STEP_WIRE_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          join(process.env.STEP_WIRE_EVIDENCE_DIR, `${protocol}-tool-integrity.json`),
          JSON.stringify(
            {
              ...evidence,
              requests: http.requests,
              toolFrames: http.toolFrames,
              fixtureErrors: http.errors,
            },
            null,
            2,
          ),
        );
      }
      await rm(root, { recursive: true, force: true });
    });
    await client.start();
    await client.setModel(providerId, modelId);
    await client.request({ type: "set_auto_retry", enabled: false });
    http.set({ kind: "baseline", text: "WIRE_INTEGRITY_BASELINE", newline: "\n" });
    const baseline = await client.promptAndWait("WIRE_INTEGRITY_BASELINE", { timeoutMs: 15000 });
    assert.equal(assistant(baseline)?.stopReason, "stop");
    assert.equal(messageText(assistant(baseline)), "WIRE_INTEGRITY_BASELINE");
    const tool = readTool(http.requests[0].body, marker);
    const rawArguments = JSON.stringify(tool.args).slice(0, -1);
    assert.throws(() => JSON.parse(rawArguments), SyntaxError);
    assert.equal(
      JSON.parse(`${rawArguments}}`)[Object.keys(tool.args)[0]],
      marker,
      "all required fields remain complete",
    );
    evidence.tool = tool;
    evidence.rawArguments = rawArguments;
    http.set({
      kind: "tool",
      ...tool,
      rawArguments,
      text: "WIRE_MALFORMED_TOOL_BLOCKED",
      newline: "\n",
    });
    const count = http.requests.length;
    const events = await client.promptAndWait("WIRE_MALFORMED_TOOL_ARGS", { timeoutMs: 20000 });
    const starts = events.filter((event) => event.type === "tool_execution_start");
    const ends = events.filter((event) => event.type === "tool_execution_end");
    const markerOutput = ends.some((event) => JSON.stringify(event).includes(markerText));
    const sentToolResults = http.requests
      .slice(count)
      .filter((request) => hasToolResult(protocol, request.body));
    evidence.events = events;
    evidence.result = {
      nativeToolStarts: starts.length,
      nativeToolEnds: ends.length,
      markerOutput,
      sentToolResults: sentToolResults.length,
      stopReason: assistant(events)?.stopReason,
      errorMessage: assistant(events)?.errorMessage,
    };
    assert.equal(http.errors.length, 0, JSON.stringify(http.errors));
    assert.equal(
      starts.length,
      1,
      `Incomplete tool JSON executed native ${tool.name}; markerOutput=${markerOutput}, HTTP toolResults=${sentToolResults.length}`,
    );
    assert.equal(
      markerOutput,
      false,
      "incomplete JSON must not expose the marker through a native tool result",
    );
    assert.equal(
      sentToolResults.length,
      1,
      "native blocked tool result must give the model a correction opportunity",
    );
    assert.equal(
      assistant(events)?.stopReason,
      "stop",
      "model may finish after receiving the blocked tool result",
    );
    assert.ok(ends.every(event => event.isError === true));
    assert.match(JSON.stringify(ends), /工具未执行|invalid.*argument|validation/i);

    for (const invalidAttempts of [1, 2]) {
      http.set({ kind: "tool-repair", ...tool, rawArguments, invalidAttempts, text: "WIRE_REPAIRED" });
      const retried = await client.promptAndWait("Check a small local file", { timeoutMs: 20000 });
      const completed = retried.filter(event => event.type === "tool_execution_end");
      if (invalidAttempts === 1) {
        assert.equal(completed.filter(event => !event.isError).length, 1);
        assert.ok(completed.some(event => !event.isError && JSON.stringify(event).includes(markerText)));
        assert.equal(assistant(retried)?.stopReason, "stop");
      } else {
        assert.ok(completed.every(event => event.isError));
        assert.equal(assistant(retried)?.stopReason, "error");
        assert.match(assistant(retried)?.errorMessage, /工具未执行/);
      }
    }
  });

test(
  "installed Step valid Anthropic structured initial input without JSON deltas",
  options,
  async (t) => {
    const protocol = "anthropic-messages",
      http = await httpFixture(protocol);
    t.after(() => http.close());
    const fixture = await projectedClient(protocol, http.baseUrl);
    const { client, root, marker, providerId, modelId } = fixture;
    const evidence = { protocol, cli: process.env.STEP_TEST_CLI, document: fixture.document };
    t.after(async () => {
      await client.stop();
      if (process.env.STEP_WIRE_EVIDENCE_DIR) {
        await mkdir(process.env.STEP_WIRE_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          join(process.env.STEP_WIRE_EVIDENCE_DIR, "anthropic-structured-input.json"),
          JSON.stringify(
            {
              ...evidence,
              requests: http.requests,
              toolFrames: http.toolFrames,
              fixtureErrors: http.errors,
            },
            null,
            2,
          ),
        );
      }
      await rm(root, { recursive: true, force: true });
    });
    await client.start();
    await client.setModel(providerId, modelId);
    await client.request({ type: "set_auto_retry", enabled: false });
    http.set({ kind: "baseline", text: "WIRE_INITIAL_BASELINE", newline: "\n" });
    assert.equal(
      assistant(await client.promptAndWait("WIRE_INITIAL_BASELINE", { timeoutMs: 15000 }))
        ?.stopReason,
      "stop",
    );
    const tool = readTool(http.requests[0].body, marker);
    http.set({
      kind: "tool",
      ...tool,
      initialObject: true,
      text: "WIRE_INITIAL_TOOL_FINAL",
      newline: "\n",
    });
    const count = http.requests.length;
    const events = await client.promptAndWait("WIRE_VALID_INITIAL_TOOL", { timeoutMs: 20000 });
    const ends = events.filter((event) => event.type === "tool_execution_end");
    evidence.tool = tool;
    evidence.events = events;
    evidence.result = {
      nativeToolStarts: events.filter((event) => event.type === "tool_execution_start").length,
      nativeToolEnds: ends.length,
      markerOutput: ends.some((event) => JSON.stringify(event).includes(markerText)),
      stopReason: assistant(events)?.stopReason,
      errorMessage: assistant(events)?.errorMessage,
    };
    assert.equal(http.errors.length, 0, JSON.stringify(http.errors));
    assert.equal(
      evidence.result.nativeToolStarts,
      1,
      "valid structured initial input must execute once",
    );
    assert.equal(ends[0]?.isError, false, JSON.stringify(ends[0]));
    assert.equal(
      evidence.result.markerOutput,
      true,
      "valid input object must preserve the required marker path",
    );
    const continuation = http.requests
      .slice(count)
      .find((request) => hasToolResult(protocol, request.body));
    assert.ok(continuation);
    assert.ok(JSON.stringify(continuation.body).includes(markerText));
    assert.equal(
      http.toolFrames[0].events.some((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta"),
      false,
    );
    assert.equal(assistant(events)?.stopReason, "stop", assistant(events)?.errorMessage);
    assert.equal(messageText(assistant(events)), "WIRE_INITIAL_TOOL_FINAL");
  },
);
