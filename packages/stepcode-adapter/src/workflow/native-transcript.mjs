import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const contextual = (entry) =>
  ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type);
const snapshotPath = (root, id) => join(root, `${encodeURIComponent(id)}.native.json`);

/** 计数和截断使用相同原生消息/摘要链，修订不改写前驱。 */
export async function captureNativeTranscript(client, root, id) {
  const response = await client.request({ type: "get_entries" });
  if (!response.success) throw new Error("无法读取子代理原生转录");
  const { entries, leafId } = response.data;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain = [];
  let cursor = leafId;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry || chain.length > entries.length) throw new Error("子代理转录链不完整");
    chain.push(entry);
    cursor = entry.parentId;
  }
  chain.reverse();
  await writeFile(snapshotPath(root, id), JSON.stringify(chain));
  return chain.filter(contextual).length;
}

export async function seedNativeTranscript(client, root, seed, id, cwd) {
  const entries = JSON.parse(await readFile(snapshotPath(root, seed.sourceSessionId), "utf8"));
  if (!Number.isInteger(seed.messageCount) || seed.messageCount < 1)
    throw new Error("子代理转录边界无效");
  const prefix = [];
  let count = 0;
  for (const entry of entries) {
    prefix.push(entry);
    if (contextual(entry)) count++;
    if (count === seed.messageCount) break;
  }
  if (count !== seed.messageCount) throw new Error("子代理原生转录短于缓存边界");
  // entry ID 仅在独立 JSONL 内寻址：保留内部引用，铸新的会话 ID 和文件。
  const path = join(root, `${encodeURIComponent(id)}.seed.jsonl`);
  await writeFile(
    path,
    [
      { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd },
      ...prefix,
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const result = await client.request({ type: "switch_session", sessionPath: path });
  if (!result.success || result.data?.cancelled) throw new Error("无法载入修订后的子代理会话前缀");
}
