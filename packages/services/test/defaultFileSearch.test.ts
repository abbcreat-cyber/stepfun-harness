import test from "node:test";
import assert from "node:assert/strict";
import { searchHostFileCandidates } from "../src/file/workspaceFileSearch.js";
import {
  mapWorkspaceFileEntriesToSearchCandidates,
  filterWorkspaceFileSearchCandidates,
} from "@zcode/shared/workspaceFileSearch";
test("空查询保持文件优先稳定顺序，足够候选后不读取余下索引", async () => {
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(
    Array.from({ length: 20000 }, (_, i) => ({
      name: "file-" + i,
      path: "D:/qa/" + i,
      relativePath: String(i),
      type: i < 20 || i % 7 === 0 ? "directory" : "file",
    })),
  );
  let reads = 0;
  const observed = new Proxy(candidates, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const actual = await searchHostFileCandidates(observed, "  ", 10);
  const expected = filterWorkspaceFileSearchCandidates(candidates, "", { limit: 10 }).map(
    ({ name, path, relativePath, type }) => ({ name, path, relativePath, type }),
  );
  assert.deepEqual(actual, expected);
  assert.ok(reads < 50, "must stop after enough files");
  for (const list of [candidates.slice(0, 20), candidates.slice(0, 40), []])
    for (const limit of [0, 1, 3.5, 100])
      for (const query of ["", "file-2"])
        assert.deepEqual(
          await searchHostFileCandidates(list, query, limit),
          filterWorkspaceFileSearchCandidates(list, query, { limit }).map(
            ({ name, path, relativePath, type }) => ({ name, path, relativePath, type }),
          ),
        );
});
