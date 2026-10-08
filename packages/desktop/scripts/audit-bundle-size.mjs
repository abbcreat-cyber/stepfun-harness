#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const argv = process.argv.slice(2);

function readArg(name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

const artifactPath = readArg("--artifact-path");
if (!artifactPath) {
  throw new Error("Usage: audit-bundle-size.mjs --artifact-path <path-to-artifact>");
}

const absoluteArtifactPath = resolve(artifactPath);
const limitsMb = {
  default: 500,
  ".dmg": 500,
  ".zip": 500,
  ".exe": 500,
  ".appimage": 500,
  ".deb": 500,
};

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const artifactStat = await stat(absoluteArtifactPath);
const extension = extname(absoluteArtifactPath).toLowerCase();
// 自包含社区版还携带 Step、Git、Python 与 LibreOffice，单独设置 1 GiB 预算。
const limit = process.env.STEP_BACKEND === "stepcode-local" && extension === ".exe"
  ? 1024 : limitsMb[extension] ?? limitsMb.default;
const sizeMiB = artifactStat.size / 1024 / 1024;

console.log(`Artifact: ${absoluteArtifactPath}`);
console.log(`Type: ${extension || "<no-extension>"}`);
console.log(`Size: ${formatMiB(artifactStat.size)}`);
console.log(`Limit: ${limit} MiB`);

if (sizeMiB > limit) {
  console.error("Bundle size audit failed:");
  console.error(`  - Artifact exceeds ${limit} MiB`);
  process.exit(1);
}
