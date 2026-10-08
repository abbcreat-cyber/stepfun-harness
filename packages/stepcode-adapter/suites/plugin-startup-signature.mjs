import { test } from "node:test";
import assert from "node:assert/strict";
import * as plugins from "../src/official-plugins.mjs";

const view = (signature, entries) => ({ signature, files: new Map(entries) });
const native = JSON.stringify({ id: "native-fixture", provision: { fixture: true } });
test("SDK native provisioning additions adopt ready signature without restarting", () => {
  const before = view("before", [["a/step.plugin.json", '{"id":"a"}']]);
  const after = view("after", [...before.files, ["native/step.plugin.json", native]]);
  assert.equal(plugins.resolveStartedPluginSignature(before, after), "after");
});
test("real plugin edits, removals and additions during startup remain refreshable", () => {
  const before = view("before", [["a/step.plugin.json", '{"id":"a"}']]);
  for (const entries of [
    [["a/step.plugin.json", '{"id":"changed"}']],
    [],
    [...before.files, ["user/step.plugin.json", '{"id":"user"}']],
    [...before.files, ["a/step-user-config.json", "{}"]],
    [
      ...before.files,
      ["native/step.plugin.json", native],
      ["a/step.plugin.json", '{"id":"changed"}'],
    ],
  ])
    assert.equal(plugins.resolveStartedPluginSignature(before, view("after", entries)), "before");
});
