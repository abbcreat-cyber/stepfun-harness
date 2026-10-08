import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerFixture } from "./provider-wire-owner-fixtures.mjs";
import { finalHttp, logicalTurn } from "./provider-wire-final-fixtures.mjs";
const options = {
  skip: !process.env.STEP_TEST_CLI && "Set STEP_TEST_CLI for native retry owner acceptance",
  timeout: 70000,
};

test(
  "installed Step owner retry: first 503 then success keeps one logical turn",
  options,
  async (t) => {
    const http = await finalHttp(),
      f = await ownerFixture(t, "openai-chat-completions", {
        http,
        evidenceName: "final-retry-success.json",
      });
    http.set({ name: "retry-success", failures: 1, text: "FINAL_RETRY_SUCCESS" });
    const result = await f.send("FINAL_RETRY_INPUT", f.choose("enabled"));
    assert.equal(result.requests.length, 2);
    assert.equal(result.requests[0].attempt, 1);
    assert.equal(result.requests[1].attempt, 2);
    const sourceCommandId = result.ack.result.commandId;
    f.records.push({
      name: "native retry one logical turn",
      passed: true,
      result: logicalTurn(result, f.bridge.frames, sourceCommandId, "completedSuccess", "success"),
    });
    assert.ok(
      result.saved.rows.some(
        (row) => row.kind === "assistantText" && row.text?.includes("FINAL_RETRY_SUCCESS"),
      ),
    );
    assert.equal(http.errors.length, 0);
  },
);

test(
  "installed Step owner retry: exhausted retries fail the same logical turn",
  options,
  async (t) => {
    const http = await finalHttp(),
      f = await ownerFixture(t, "openai-chat-completions", {
        http,
        evidenceName: "final-retry-exhausted.json",
      });
    http.set({ name: "retry-exhausted", failures: Infinity, text: "MUST_NOT_SUCCEED" });
    const result = await f.send("FINAL_RETRY_EXHAUSTED_INPUT", f.choose("tiny"));
    assert.ok(result.requests.length > 1, "real SDK must retry before exhausting");
    f.records.push({
      name: "native retry exhausted one logical turn",
      passed: true,
      result: logicalTurn(
        result,
        f.bridge.frames,
        result.ack.result.commandId,
        "failed",
        "error_during_execution",
      ),
    });
    assert.equal(
      result.saved.rows.some((row) => row.kind === "toolCall"),
      false,
    );
    assert.equal(http.errors.length, 0);
  },
);
