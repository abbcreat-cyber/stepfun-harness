import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectionFixture } from "./provider-projection-client.mjs";
import { launchBridge, waitForExit } from "./helpers.mjs";
import { httpFixture, projectedClient, protocols } from "./provider-wire-fixtures.mjs";

export function ownerMaps(protocol) {
  const reasoning =
    protocol === protocols[0]
      ? '{"fixture_raw":reasoningLevel,"reasoning_effort":reasoningLevel=="disabled"?null:(reasoningLevel=="enabled"?"high":"low")}'
      : protocol === protocols[1]
        ? '{"fixture_raw":reasoningLevel,"reasoning":reasoningLevel=="disabled"?null:{"effort":reasoningLevel=="enabled"?"high":"low"}}'
        : '{"fixture_raw":reasoningLevel,"thinking":reasoningLevel=="disabled"?null:{"type":"enabled","budget_tokens":reasoningLevel=="enabled"?2048:1024}}';
  const outputField = protocol === protocols[1] ? "max_output_tokens" : "max_tokens";
  return {
    reasoningLevel: { values: ["disabled", "enabled", "tiny"], map: reasoning },
    maxOutputTokens: {
      max: 4096,
      map: `{"${outputField}":maxOutputTokens,"fixture_limit":maxOutputTokens}`,
    },
  };
}

export function assertMapped(protocol, request, value, limit = 4096) {
  assert.equal(request.body.fixture_raw, value);
  assert.equal(request.body.fixture_limit, limit);
  assert.equal(request.body[protocol === protocols[1] ? "max_output_tokens" : "max_tokens"], limit);
  if (protocol === protocols[0])
    assert.equal(
      request.body.reasoning_effort,
      value === "disabled" ? undefined : value === "enabled" ? "high" : "low",
    );
  else if (protocol === protocols[1])
    assert.equal(
      request.body.reasoning?.effort,
      value === "disabled" ? undefined : value === "enabled" ? "high" : "low",
    );
  else
    assert.deepEqual(
      request.body.thinking,
      value === "disabled"
        ? undefined
        : { type: "enabled", budget_tokens: value === "enabled" ? 2048 : 1024 },
    );
}

export async function ownerFixture(t, protocol, options = {}) {
  const http = options.http ?? (await httpFixture(protocol));
  t.after(() => http.close());
  const fixture = await projectedClient(protocol, http.baseUrl, {
    optionSpecs: ownerMaps(protocol),
    native: {
      reasoning: false,
      samplingParams: { fixture_epoch: "before" },
      ...(protocol === protocols[0] ? { compat: { maxTokensField: "max_tokens" } } : {}),
    },
  });
  const stateDir = join(fixture.root, "bridge-state"),
    sessionId = "owner-mapped";
  await mkdir(stateDir);
  const env = {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => /API_KEY|TOKEN|SECRET|PROXY|^(STEP_|STEPCODE_)/i.test(key))
        .map((key) => [key, undefined]),
    ),
    ...fixture.env,
    STEPCODE_STORAGE_ROOT_DIR: join(fixture.root, "runtime-storage"),
    ...options.environment?.(fixture),
  };
  const bridge = launchBridge(
    [
      "--step-cli",
      JSON.stringify([process.env.STEP_TEST_CLI, "--mode", "rpc", "--no-extensions"]),
      "--step-cwd",
      fixture.root,
    ],
    env,
    { stateDir, cwd: fixture.root },
  );
  let stderr = "",
    sequence = 0;
  bridge.child.stderr.on("data", (chunk) => (stderr += chunk));
  const records = [];
  const persisted = async () =>
    JSON.parse(await readFile(join(stateDir, "conversations", `${sessionId}.json`), "utf8"));
  t.after(async () => {
    bridge.child.stdin.end();
    await waitForExit(bridge.child, { timeoutMs: 15000, label: "real provider owner bridge" });
    if (process.env.STEP_WIRE_EVIDENCE_DIR) {
      await mkdir(process.env.STEP_WIRE_EVIDENCE_DIR, { recursive: true });
      await writeFile(
        join(process.env.STEP_WIRE_EVIDENCE_DIR, options.evidenceName ?? `${protocol}-owner.json`),
        JSON.stringify(
          {
            protocol,
            cli: process.env.STEP_TEST_CLI,
            records,
            requests: http.requests,
            frames: bridge.frames,
            stderr,
            persisted: await persisted().catch(() => undefined),
            fixtureErrors: http.errors,
          },
          null,
          2,
        ),
      );
    }
    await rm(fixture.root, { recursive: true, force: true });
  });
  const choose = (value) => ({
    providerId: fixture.providerId,
    modelId: fixture.modelId,
    options: { reasoningLevel: value },
  });
  async function command(type, payload = {}) {
    const id = ++sequence,
      commandId = `owner-${id}`;
    bridge.send({ id, method: "v4/command", params: { commandId, sessionId, type, payload } });
    return bridge.waitFor((frame) => frame.id === id, {
      timeoutMs: 25000,
      label: `${type} ${commandId}`,
    });
  }
  function completed(after) {
    return bridge.waitFor(
      (frame) =>
        bridge.frames.indexOf(frame) >= after &&
        frame.params?.sessionId === sessionId &&
        frame.params?.type === "turn.completed",
      { timeoutMs: 25000, label: "native owner turn completed" },
    );
  }
  async function send(text, selection) {
    const after = bridge.frames.length,
      before = http.requests.length;
    const ack = await command("sendText", {
      text,
      ...(selection ? { modelSelection: selection } : {}),
    });
    assert.equal(ack.result?.status, "accepted", JSON.stringify(ack));
    const final = await completed(after);
    // legacy 终态先发布，正文快照随后持久化；以对应 V4 终态快照作为落盘读取屏障。
    await bridge.waitFor(
      (frame) => {
        if (
          bridge.frames.indexOf(frame) < after ||
          frame.params?.topic !== `conversation/${sessionId}`
        )
          return false;
        const rows = frame.params.frame?.payload?.snapshot?.rows?.window ?? [];
        return (
          rows.some(
            (row) =>
              row.kind === "turnHeader" &&
              row.turnId === final.params.turnId &&
              row.state !== "running",
          ) &&
          (!final.params.payload.response ||
            // 进展和结论各占一行，legacy response 则拼接本轮全部正文。
            rows.filter(row => row.kind === "assistantText" && row.turnId === final.params.turnId)
              .map(row => row.text ?? "").join("").includes(final.params.payload.response))
        );
      },
      { timeoutMs: 15000, label: "persisted V4 terminal snapshot" },
    );
    return { ack, final, requests: http.requests.slice(before), saved: await persisted() };
  }
  async function sync(mutator) {
    const next = structuredClone(fixture.registryView);
    mutator(next);
    const result = await projectionFixture({ views: [next], env: fixture.env });
    fixture.registryView = result.views[0];
  }
  const currentView = () => fixture.registryView;
  await options.beforeCreate?.({
    ...fixture,
    http,
    bridge,
    command,
    completed,
    persisted,
    sync,
    currentView,
  });
  const created = await command("createSession", {
    workspaceId: options.workspaceId?.(fixture) ?? fixture.root,
    config: { modelSelection: choose("enabled") },
  });
  if (!options.expectCreateFailure)
    assert.equal(created.result?.status, "accepted", JSON.stringify(created));
  bridge.send({
    id: ++sequence,
    method: "v4/conversation/subscribe",
    params: {
      topic: `conversation/${sessionId}`,
      connectionId: "owner-wire",
      clientMode: "desktop-continuous",
    },
  });
  await bridge.waitFor((frame) => frame.id === sequence, { label: "real owner subscription" });
  return {
    ...fixture,
    http,
    bridge,
    records,
    choose,
    command,
    completed,
    send,
    persisted,
    sync,
    currentView,
    created,
  };
}
