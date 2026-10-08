import { cp, mkdir, readFile, realpath, writeFile, access } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function findDependency(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (await exists(join(candidate, "package.json"))) return realpath(candidate);
    if (dirname(dir) === dir) throw new Error(`Missing production dependency ${name} from ${from}`);
  }
}

// 保留每个父包实际解析到的版本；复制真实文件，不留下指向开发机的 junction。
export async function deployAdapter(source, destination) {
  const installed = new Map(), queue = [], inventory = [];
  async function install(src, dest) {
    src = await realpath(src);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true, dereference: true,
      filter: path => !["node_modules", ".git", ".cache"].includes(basename(path)) || path === src });
    installed.set(resolve(dest).toLowerCase(), src);
    queue.push({ src, dest });
  }
  await install(source, destination);
  for (let i = 0; i < queue.length; i++) {
    const { src, dest } = queue[i];
    const pkg = JSON.parse(await readFile(join(src, "package.json"), "utf8"));
    inventory.push({ name: pkg.name, version: pkg.version, path: relative(destination, dest).replaceAll("\\", "/"), license: pkg.license ?? "See package notices" });
    const optional = pkg.optionalDependencies ?? {};
    for (const name of Object.keys({ ...pkg.dependencies, ...optional })) {
      let dep;
      try { dep = await findDependency(src, name); }
      catch (error) { if (name in optional) continue; throw error; }
      const meta = JSON.parse(await readFile(join(dep, "package.json"), "utf8"));
      if (meta.os && !meta.os.includes(process.platform) || meta.cpu && !meta.cpu.includes(process.arch)) continue;
      let existing;
      for (let dir = dest; ; dir = dirname(dir)) {
        const key = resolve(dir, "node_modules", name).toLowerCase();
        if (installed.has(key)) { existing = installed.get(key); break; }
        if (dir === destination || dirname(dir) === dir) break;
      }
      if (existing === dep) continue;
      const global = join(destination, "node_modules", name);
      const target = installed.has(resolve(global).toLowerCase()) ? join(dest, "node_modules", name) : global;
      if (installed.get(resolve(target).toLowerCase()) === dep) continue;
      await install(dep, target);
    }
  }
  await writeFile(join(destination, "dependency-inventory.json"), JSON.stringify(inventory, null, 2));
  console.log(`Adapter deployed: ${inventory.length} production packages`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await deployAdapter(resolve("packages/stepcode-adapter"), resolve(process.argv[2]));
}
