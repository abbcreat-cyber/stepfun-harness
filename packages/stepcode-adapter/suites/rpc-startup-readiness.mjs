import { test } from "node:test";
import assert from "node:assert/strict";
import { mockClient } from "./helpers.mjs";
import {
  COMMUNICATION_COMMAND,
  COMMUNICATION_DESCRIPTION,
} from "../src/provider-communication.mjs";

test("RPC startup binds spawned PID before ready and awaits the binding", async () => {
  const client = mockClient();
  let bound = false;
  client.options.onSpawn = async (pid) => {
    assert.equal(pid, client.child.pid);
    await new Promise((resolve) => setTimeout(resolve, 15));
    bound = true;
  };
  try {
    await client.start();
    assert.equal(bound, true);
  } finally {
    await client.stop();
  }
});

test("RPC startup rejects failed PID binding", async () => {
  const client = mockClient();
  client.options.onSpawn = () => {
    throw new Error("fixture relay binding failed");
  };
  try {
    await assert.rejects(client.start(), /relay binding failed/);
  } finally {
    await client.stop();
  }
});

test("PID binds once before required trusted verification, never on later queries", async () => {
  const client = mockClient();
  client.options.communicationMode = "required";
  let bindings = 0;
  client.options.onSpawn = () => {
    bindings++;
  };
  client.getCommands = async () => {
    assert.equal(bindings, 1);
    return [
      { name: COMMUNICATION_COMMAND, description: COMMUNICATION_DESCRIPTION, source: "extension" },
    ];
  };
  try {
    await client.start();
    await client.getCommands();
    assert.equal(bindings, 1);
  } finally {
    await client.stop();
  }
});
