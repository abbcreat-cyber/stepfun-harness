import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useServices } from "./useServices.js";

const EMPTY_ENTRIES: WorkspaceFileEntry[] = [];

/** 共享 Host 检索路径，避免命令面板另存全仓列表后永远看不到新文件。 */
export function useWorkspaceFileQuery(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  limit: number,
) {
  const { fileService } = useServices();
  const scope = useMemo(
    () => ({ error: null as Error | null, lastMissQuery: null as string | null }),
    [fileService, workspacePath, workspaceIdentity, enabled],
  );
  const [result, setResult] = useState<{
    scope: typeof scope; query: string; limit: number; entries: WorkspaceFileEntry[]; loading: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled || scope.error) return;
    let active = true;
    setResult({ scope, query, limit, entries: [], loading: true });
    const params = { rootPath: workspacePath, workspaceIdentity, query, limit };
    const search = async () => {
      try {
        let entries = await fileService.searchWorkspaceFiles(params);
        if (!active) return;
        const normalizedQuery = query.trim().toLowerCase();
        if (entries.length === 0 && normalizedQuery && scope.lastMissQuery !== normalizedQuery) {
          scope.lastMissQuery = normalizedQuery;
          // 必须绕过 Host TTL，而不是仅刷新 renderer 中的副本。
          entries = await fileService.searchWorkspaceFiles({ ...params, refresh: true });
          if (!active) return;
        }
        setResult({ scope, query, limit, entries, loading: false });
      } catch (error) {
        if (!active) return;
        scope.error = error instanceof Error ? error : new Error(String(error));
        setResult({ scope, query, limit, entries: [], loading: false });
      }
    };
    void search();
    return () => { active = false; };
  }, [enabled, fileService, workspacePath, workspaceIdentity, query, limit, scope]);

  const current = enabled && result?.scope === scope && result.query === query && result.limit === limit;
  return {
    entries: current ? result.entries : EMPTY_ENTRIES,
    loading: enabled && !scope.error && (!current || result.loading),
    error: enabled ? scope.error : null,
  };
}
