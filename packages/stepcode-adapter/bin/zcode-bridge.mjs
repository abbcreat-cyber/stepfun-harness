#!/usr/bin/env node
import { SessionRouter } from "../src/session-router.mjs";
import { attachJsonlLineReader } from "../src/jsonl.mjs";

const router = new SessionRouter({
  args: process.argv.slice(2),
  write: (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`),
  diagnostic: (text) => process.stderr.write(text),
});
attachJsonlLineReader(process.stdin, (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  router.receive(frame);
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await router.close();
  process.exit(0);
}
process.stdin.on("end", () => void close());
process.stdin.on("error", () => void close());
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());

process.stdout.on("error", () => void close());
