// 检查点展示使用有界 Myers 行差异；恢复始终使用原始字节快照，不能靠展示补丁写文件。
function tokens(data) {
  const text = data == null ? "" : Buffer.from(data, "base64").toString("utf8");
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function edits(before, after, budget) {
  let previous = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= before.length + after.length; d++) {
    const next = new Map();
    for (let k = -d; k <= d; k += 2) {
      if (--budget < 0) return null;
      const down = k === -d || (k !== d && (previous.get(k - 1) ?? -Infinity) < (previous.get(k + 1) ?? -Infinity));
      let x = down ? previous.get(k + 1) : previous.get(k - 1) + 1;
      let y = x - k;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        if (--budget < 0) return null;
        x++; y++;
      }
      next.set(k, x);
      if (x === before.length && y === after.length) {
        const result = [];
        for (let level = d; level > 0; level--) {
          const prior = trace[level - 1], diagonal = x - y;
          const fromDown = diagonal === -level || (diagonal !== level && (prior.get(diagonal - 1) ?? -Infinity) < (prior.get(diagonal + 1) ?? -Infinity));
          const priorK = fromDown ? diagonal + 1 : diagonal - 1;
          const priorX = prior.get(priorK), priorY = priorX - priorK;
          while (x > priorX && y > priorY) { result.push([" ", before[--x]]); y--; }
          if (fromDown) result.push(["+", after[--y]]);
          else result.push(["-", before[--x]]);
        }
        while (x > 0 && y > 0) { result.push([" ", before[--x]]); y--; }
        return result.reverse();
      }
    }
    trace.push(next); previous = next;
  }
}

export function checkpointDiff(beforeData, afterData, { budget = 200000 } = {}) {
  const before = tokens(beforeData), after = tokens(afterData);
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end++;
  const removed = before.slice(start, before.length - end), added = after.slice(start, after.length - end);
  // 极端全文件改写有界退化为整段替换，避免同步差异计算卡住适配层消息循环。
  const changes = edits(removed, added, budget) ?? [...removed.map(line => ["-", line]), ...added.map(line => ["+", line])];
  const patches = [];
  let oldLine = start + 1, newLine = start + 1, patch;
  for (const [kind, text] of changes) {
    if (kind === " ") { patch = undefined; oldLine++; newLine++; continue; }
    if (!patch) {
      patch = { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0, lines: [] };
      patches.push(patch);
    }
    patch.lines.push(kind + text.replace(/\n$/, ""));
    if (!text.endsWith("\n")) patch.lines.push("\\ No newline at end of file");
    if (kind === "-") { patch.oldLines++; oldLine++; }
    else { patch.newLines++; newLine++; }
  }
  // unified diff 的空范围锚定到上一行；首行插入/删除使用 0。
  for (const p of patches) { if (!p.oldLines) p.oldStart--; if (!p.newLines) p.newStart--; }
  return { patches, additions: patches.reduce((n, p) => n + p.newLines, 0), deletions: patches.reduce((n, p) => n + p.oldLines, 0) };
}
