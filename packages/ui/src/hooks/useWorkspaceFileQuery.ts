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
    () => ({ pending: Promise.resolve(), lastMissQuery: null as string | null }),
    [fileService, workspacePath, workspaceIdentity, enabled],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    query: string;
    limit: number;
    entries: WorkspaceFileEntry[];
    loading: boolean;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setResult({ scope, query, limit, entries: [], loading: true, error: null });
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
        setResult({ scope, query, limit, entries, loading: false, error: null });
      } catch (error) {
        if (!active) return;
        // 失败只属于本次查询，不能让面板在下一次输入后仍永久拒绝检索。
        setResult({
          scope,
          query,
          limit,
          entries: [],
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    };
    // 同一作用域只执行一个在途查询；旧输入收口后跳过已失效输入，避免连续键入堆积 RPC。
    const run = async () => {
      if (active) await search();
    };
    scope.pending = scope.pending.then(run, run);
    return () => {
      active = false;
    };
  }, [enabled, fileService, workspacePath, workspaceIdentity, query, limit, scope]);

  const current =
    enabled && result?.scope === scope && result.query === query && result.limit === limit;
  return {
    entries: current ? result.entries : EMPTY_ENTRIES,
    loading: enabled && (!current || result.loading),
    error: current ? result.error : null,
  };
}
