import test from "node:test";
import assert from "node:assert/strict";
import { createAgentConversationTransport } from "../src/v4/agentConversationTransport.ts";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";

function transport(read, mode = "desktop-continuous") {
  return createAgentConversationTransport(
    {
      helloConversationV4: async () => ({
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: "test",
        clientMode: mode,
        deliveryProfile: mode === "desktop-continuous" ? "continuous" : "replayable",
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: false,
          localTerminal: false,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      }),
      initializeConversationV4: async () => ({}),
      attachmentReadV4: read,
    },
    { workspacePath: "D:/qa", workspaceIdentity: "qa" },
  );
}
const params = { sessionId: "test", ref: "test-image" };
for (const size of [0, 1400000, 2100000]) {
  test(`预览 ${size} 字节完整且小附件在下一块前写入最终缓冲`, async () => {
    const source = Buffer.alloc(size, 73),
      copyOffsets = [],
      requestCopies = [];
    const original = Uint8Array.prototype.set;
    Uint8Array.prototype.set = function (bytes, offset) {
      if (this.length === size && size > 0) copyOffsets.push(offset);
      return original.call(this, bytes, offset);
    };
    const t = transport(async ({ offset, limit }) => {
      requestCopies.push(copyOffsets.length);
      const end = Math.min(size, offset + limit);
      return {
        dataBase64: source.subarray(offset, end).toString("base64"),
        mediaType: "image/png",
        totalBytes: size,
        nextOffset: end < size ? end : null,
      };
    });
    try {
      const result = await t.attachmentRead(params);
      assert.deepEqual(Buffer.from(result.bytes), source);
      if (size === 1400000) assert.deepEqual(requestCopies, [0, 1, 2]);
      if (size === 2100000) assert.ok(requestCopies.every((x) => x === 0));
    } finally {
      Uint8Array.prototype.set = original;
    }
  });
}
test("取消在途读取后不再请求下一块", async () => {
  const c = new AbortController();
  let calls = 0;
  const t = transport(async () => {
    calls++;
    c.abort();
    return { dataBase64: "YQ==", mediaType: "image/png", totalBytes: 2, nextOffset: 1 };
  });
  await assert.rejects(t.attachmentRead({ ...params, signal: c.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});
for (const [name, frames, error] of [
  ["size", [{ totalBytes: 1, dataBase64: "YWI=", nextOffset: null }], "previewSizeMismatch"],
  ["offset", [{ totalBytes: 2, dataBase64: "YQ==", nextOffset: 2 }], "previewOffsetMismatch"],
  ["truncated", [{ totalBytes: 2, dataBase64: "YQ==", nextOffset: null }], "previewTruncated"],
  ["empty", [{ totalBytes: 2, dataBase64: "", nextOffset: 0 }], "previewEmptyChunk"],
  [
    "changed",
    [
      { totalBytes: 2, dataBase64: "YQ==", nextOffset: 1 },
      { totalBytes: 3, dataBase64: "Yg==", nextOffset: null },
    ],
    "previewChangedDuringRead",
  ],
])
  test(`Web预览拒绝 ${name}`, async () => {
    let i = 0;
    const t = transport(
      async () => ({ mediaType: "image/png", ...frames[i++] }),
      "web-remote-replayable",
    );
    await assert.rejects(t.attachmentRead(params), new RegExp(error));
  });
