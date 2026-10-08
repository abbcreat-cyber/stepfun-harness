import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionConfigSignature } from "../src/extension-config-signature.mjs";
import { tmpdir } from "node:os";
test("extension signature sees global, project and local entry dependencies", async (t) => {
  const root = await mkdtemp(join(process.env.STEP_TEST_ROOT || tmpdir(), "extension-config-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const agentDir = join(root, "agent"),
    cwd = join(root, "workspace");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".stepcode/extensions"), { recursive: true });
  const source = join(root, "source.mjs"),
    env = { HOME: root, USERPROFILE: root, STEP_CODING_AGENT_DIR: agentDir };
  await writeFile(source, "export default ()=>1;");
  await writeFile(
    join(agentDir, "extensions/entry.ts"),
    "export {default} from " + JSON.stringify(pathToFileURL(source).href) + ";",
  );
  const before = await extensionConfigSignature(env, cwd);
  await writeFile(source, "export default ()=>2;");
  const dependencyChanged = await extensionConfigSignature(env, cwd);
  assert.notEqual(dependencyChanged, before);
  await writeFile(join(cwd, ".stepcode/extensions/entry.mjs"), "export default ()=>3;");
  assert.notEqual(await extensionConfigSignature(env, cwd), dependencyChanged);
});
