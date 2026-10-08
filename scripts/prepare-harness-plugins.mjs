import { cp, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
export async function preparePlugins() {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const source = join(repo, "vendor/step-official-plugins"), target = join(repo, "packages/desktop/build/step-official-plugins");
  const catalog = JSON.parse(await readFile(join(source, "catalog.json"), "utf8"));
  await mkdir(target, { recursive: true }); await cp(source, target, { recursive: true });
  console.log(`Prepared ${catalog.plugins.length} bundled plugin packages; original licenses preserved.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await preparePlugins();
