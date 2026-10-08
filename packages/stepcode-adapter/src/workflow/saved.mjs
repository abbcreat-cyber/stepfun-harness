import { unlink } from "node:fs/promises";
import { savedWorkflows } from "./dependencies.mjs";

export function createSavedWorkflowCatalog(cwd, homeDir) {
  const target = (params) => ({
    cwd,
    homeDir,
    name: params.name,
    scope: params.scope ?? "project",
  });
  return {
    list(params = {}) {
      const options = { cwd, homeDir, scope: params.scope ?? "project" };
      const { entries, invalid } = savedWorkflows.listSavedWorkflows(options);
      return {
        workflows: entries,
        invalid,
        dir: savedWorkflows.savedWorkflowRoot(cwd, options.scope, { homeDir }).dir,
      };
    },
    get(params) {
      const result = savedWorkflows.resolveSavedWorkflow(target(params));
      if (!result.ok)
        return {
          ok: false,
          reason: result.reason,
          ...(result.detail ? { detail: result.detail } : {}),
        };
      const { name, path, scope, meta, script } = result;
      return { ok: true, name, path, scope, meta, script };
    },
    update(params) {
      const result = this.get(params);
      if (!result.ok) return result;
      savedWorkflows.saveSavedWorkflow({
        ...target(params),
        meta: params.meta,
        script: result.script,
      });
      return { ok: true, path: result.path };
    },
    async delete(params) {
      const result = this.get(params);
      if (!result.ok) return result;
      await unlink(result.path);
      return { ok: true, path: result.path };
    },
  };
}
