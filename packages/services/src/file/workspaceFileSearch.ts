import { setImmediate } from "node:timers/promises";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type WorkspaceFileSearchCandidate,
} from "@zcode/shared/workspaceFileSearch";

/** 分批解码已有 packed 索引，防止把 Renderer 的长任务简单搬到共享 Host。 */
export async function buildHostFileSearchCandidates(packed: string, rootPath: string) {
  const candidates: WorkspaceFileSearchCandidate[] = [];
  for (let offset = 0; offset < packed.length; ) {
    const newline = packed.indexOf("\n", offset + 128_000);
    const end = newline < 0 ? packed.length : newline + 1;
    const entries = unpackWorkspaceFileEntries(packed.slice(offset, end), rootPath);
    for (const candidate of mapWorkspaceFileEntriesToSearchCandidates(entries))
      candidates.push(candidate);
    offset = end;
    await setImmediate();
  }
  return candidates;
}

export async function searchHostFileCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  limit: number,
): Promise<WorkspaceFileEntry[]> {
  if (!query.trim() && Number.isFinite(limit)) {
    const maximum = Math.max(0, Math.trunc(limit));
    if (maximum === 0) return [];
    const files: WorkspaceFileSearchCandidate[] = [],
      directories: WorkspaceFileSearchCandidate[] = [];
    // 默认顺序仅要求文件优先且同类稳定；文件已足量后，后面的项不可能进入结果。
    // 目录暂存也有界，不为只显示80项的空查询扫描/排序整个大型项目。
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.type === "directory") {
        if (directories.length < maximum) directories.push(candidate);
      } else {
        files.push(candidate);
        if (files.length === maximum) break;
      }
      if ((index + 1) % 2048 === 0) await setImmediate();
    }
    return files
      .concat(directories)
      .slice(0, maximum)
      .map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
  }
  let best: WorkspaceFileSearchCandidate[] = [];
  // top-K 的输入按原索引顺序分批；同分时原序稳定，分批合并与整表排序一致。
  for (let offset = 0; offset < candidates.length; offset += 2048) {
    best = filterWorkspaceFileSearchCandidates(
      [...best, ...candidates.slice(offset, offset + 2048)],
      query,
      { limit },
    );
    await setImmediate();
  }
  return best.map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
}
