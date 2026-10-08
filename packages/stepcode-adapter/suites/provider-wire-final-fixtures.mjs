import { createServer } from "node:http";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectionFixture } from "./provider-projection-client.mjs";
import { textEvents, protocols } from "./provider-wire-fixtures.mjs";

export async function finalHttp() {
  const requests = [],
    errors = [],
    closed = [];
  let action = { text: "FINAL_TEXT", failures: 0 },
    attempt = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const piece of req) chunks.push(piece);
      const current = action,
        captured = {
          path: req.url,
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks)),
          attempt: ++attempt,
          action: current.name,
        };
      requests.push(captured);
      res.once("close", () => closed.push(captured));
      if (attempt <= current.failures) {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ error: { message: "FINAL_RETRY_503", type: "server_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const wire = textEvents(protocols[0], current.text)
        .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
        .join("");
      const bytes = Buffer.from(wire);
      for (let offset = 0; offset < bytes.length && !res.destroyed; offset += 23) {
        res.write(bytes.subarray(offset, offset + 23));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (!res.destroyed) res.end();
    } catch (error) {
      errors.push(error.message);
      if (!res.destroyed) res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    errors,
    closed,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    set(next) {
      action = next;
      attempt = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function boundedWait(predicate, label) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function fakeHost(bridge, fixture, state) {
  const method = "interaction/prepareModelExecution";
  state.calls ??= [];
  state.errors ??= [];
  let buffer = "";
  const handleFrame = async (frame) => {
    try {
      const params = frame.params,
        ready = state.ready,
        mode = state.mode;
      state.calls.push({ id: frame.id, params, readyAtCall: ready, mode });
      if (mode === "missing") {
        await projectionFixture({ action: "contract", params });
        bridge.send({
          id: frame.id,
          error: { code: -32601, message: "fixture Host handler missing" },
        });
        return;
      }
      const scope = params.workspace;
      const sameScope =
        scope.workspacePath === fixture.root &&
        scope.workspaceIdentity === state.identity &&
        scope.workspaceKey === state.identity;
      const eligible =
        !params.selection ||
        state.allowed.has(`${params.selection.providerId}/${params.selection.modelId}`);
      const result = !sameScope
        ? {
            ready: false,
            error: { code: "workspace_mismatch", message: "fixture Host workspace mismatch" },
          }
        : !ready
          ? {
              ready: false,
              error: {
                code: "model_projection_failed",
                message: "fixture Host projection not ready",
              },
            }
          : !eligible
            ? {
                ready: false,
                error: {
                  code: "model_selection_unavailable",
                  message: "fixture Registry tuple unavailable",
                },
              }
            : { ready: true };
      const parsed = await projectionFixture({ action: "contract", params, result });
      bridge.send({ id: frame.id, result: parsed.result });
    } catch (error) {
      state.errors.push(error.message);
      bridge.send({ id: frame.id, error: { code: -32602, message: error.message } });
    }
  };
  const handler = (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame.method === method && frame.id !== undefined) void handleFrame(frame);
    }
  };
  bridge.child.stdout.on("data", handler);
  return () => bridge.child.stdout.off("data", handler);
}
export function hostEnvironment(fixture, state) {
  return {
    STEPCODE_HOST_MODEL_ADMISSION: "1",
    STEPCODE_HOST_WORKSPACE_REF: JSON.stringify({
      workspacePath: fixture.root,
      workspaceKey: state.identity,
      workspaceIdentity: state.identity,
    }),
  };
}

export async function twoModels(f) {
  await f.sync((view) => {
    const first = view.models[0];
    first.config.native.headers["X-Owner-Model"] = "A";
    first.config.optionSpecs.reasoningLevel.map =
      first.config.optionSpecs.reasoningLevel.map.replace(
        '{"fixture_raw":',
        '{"fixture_model_map":"A","fixture_raw":',
      );
    const second = structuredClone(first);
    second.modelId = "unlisted-second-20261008";
    second.config.native.headers["X-Owner-Model"] = "B";
    second.config.optionSpecs.reasoningLevel.map =
      second.config.optionSpecs.reasoningLevel.map.replace('"A"', '"B"');
    view.models.push(second);
  });
}

export async function addUnownedOldTuple(f) {
  const main = f.currentView(),
    old = structuredClone(main);
  old.providerId = "wire-unowned-old-provider";
  old.models = [{ ...old.models[0], modelId: "unlisted-old-model" }];
  await projectionFixture({ views: [main, old], env: f.env });
  const path = join(f.root, "models.json"),
    document = JSON.parse(await readFile(path, "utf8"));
  // 只去掉隔离 fixture 的 ownership 证据，模型定义全部仍由生产投影创建。
  delete document._stepcodeDesktopProviders.providers[old.providerId];
  await writeFile(path, JSON.stringify(document));
  await projectionFixture({ views: [main], env: f.env });
  assert.ok(
    JSON.parse(await readFile(path, "utf8")).providers[old.providerId],
    "unowned SDK catalog entry must remain",
  );
  return {
    providerId: old.providerId,
    modelId: old.models[0].modelId,
    options: { reasoningLevel: "enabled" },
  };
}

export function logicalTurn(result, frames, sourceCommandId, state, legacyResult) {
  const headers = result.saved.rows.filter(
    (row) => row.kind === "turnHeader" && row.sourceCommandId === sourceCommandId,
  );
  const inputs = result.saved.rows.filter(
    (row) => row.kind === "userInput" && row.sourceCommandId === sourceCommandId,
  );
  assert.equal(headers.length, 1);
  assert.equal(inputs.length, 1);
  assert.ok(headers[0].endedAt);
  assert.equal(headers[0].state, state);
  assert.equal(inputs[0].turnId, headers[0].turnId);
  assert.equal(result.final.params.turnId, headers[0].turnId);
  assert.equal(result.final.params.payload.resultType, legacyResult);
  assert.equal(
    result.saved.rows.some((row) => row.kind === "turnHeader" && row.state === "running"),
    false,
  );
  assert.equal(
    frames.filter(
      (frame) =>
        frame.params?.type === "turn.completed" && frame.params.turnId === headers[0].turnId,
    ).length,
    1,
  );
  return {
    turnId: headers[0].turnId,
    sourceCommandId,
    headerState: headers[0].state,
    endedAt: headers[0].endedAt,
    legacyResult,
  };
}
