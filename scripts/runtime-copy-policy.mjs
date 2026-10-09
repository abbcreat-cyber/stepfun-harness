import { basename, relative } from "node:path";

const developmentDirectories = new Set(["test", "tests", "__tests__", "suites", "coverage", ".git", ".cache", "__pycache__"]);
/** Only classify file paths. Never edit JS comments or strip TypeScript's runtime compiler inputs. */
export function includeRuntimePath(sourceRoot, path) {
  const pieces = relative(sourceRoot, path).replaceAll("\\", "/").split("/");
  if (pieces.includes("sources") || pieces.includes("licenses") || pieces.includes("LICENSES")) return true;
  if (pieces.some(piece => developmentDirectories.has(piece))) return false;
  const name = basename(path);
  return !name.endsWith(".map") && !name.endsWith(".pyc") && !["_virtualenv.pth", "_virtualenv.py", "direct_url.json"].includes(name);
}
