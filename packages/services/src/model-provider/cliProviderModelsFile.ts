import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireFileLock } from "@zcode/shared/node";
import { atomicWriteText } from "../fs/atomicFileUtils.js";

export const STEP_CLI_OWNERSHIP_KEY = "_stepcodeDesktopProviders";
type Document = Record<string, unknown> & { providers?: Record<string, unknown> };
type Ownership = {
  version: 1;
  owner: "stepcode-desktop";
  providers: Record<string, { hash: string }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** 只接管可证明的旧 writer 形状；未知额外字段和已变化的值都不是归属证据。 */
function matchesLegacyProjection(existing: unknown, desired: unknown): boolean {
  if (!isObject(existing) || !isObject(desired)) return false;
  if (Object.keys(existing).sort().join(",") !== "api,apiKey,baseUrl,models") return false;
  if (
    !["api", "apiKey", "baseUrl"].every(
      (key) => canonical(existing[key]) === canonical(desired[key]),
    )
  )
    return false;
  if (
    !Array.isArray(existing.models) ||
    !Array.isArray(desired.models) ||
    existing.models.length !== desired.models.length
  )
    return false;
  const desiredModels = desired.models;
  const allowed = new Set(["id", "input", "reasoning", "contextWindow", "maxTokens"]);
  return existing.models.every((model, index) => {
    const next: unknown = desiredModels[index];
    if (
      !isObject(model) ||
      !isObject(next) ||
      typeof model.id !== "string" ||
      !Array.isArray(model.input)
    )
      return false;
    if (
      !Object.keys(model).every(
        (key) =>
          allowed.has(key) &&
          Object.hasOwn(next, key) &&
          canonical(model[key]) === canonical(next[key]),
      )
    )
      return false;
    return Object.hasOwn(model, "id") && Object.hasOwn(model, "input");
  });
}

function readOwnership(document: Document): Ownership | undefined {
  const value = document[STEP_CLI_OWNERSHIP_KEY];
  if (value === undefined) return undefined;
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(",") !== "owner,providers,version" ||
    value.version !== 1 ||
    value.owner !== "stepcode-desktop" ||
    !isObject(value.providers)
  ) {
    throw new Error("Step CLI ownership 元数据损坏或版本不支持；同步中止且未改动配置");
  }
  for (const entry of Object.values(value.providers)) {
    if (
      !isObject(entry) ||
      Object.keys(entry).join(",") !== "hash" ||
      typeof entry.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.hash)
    ) {
      throw new Error("Step CLI ownership 元数据损坏；同步中止且未改动配置");
    }
  }
  return value as Ownership;
}

async function readCurrent(path: string): Promise<Document> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!isObject(parsed) || (parsed.providers !== undefined && !isObject(parsed.providers)))
      throw new Error();
    return parsed;
  } catch {
    throw new Error(
      `Step CLI 模型配置文件已损坏（${path}），请人工检查后再写入；本次同步已中止且未改动该文件`,
    );
  }
}

function reconcile(current: Document, desired: ReadonlyMap<string, unknown>): Document {
  const ownership = readOwnership(current);
  const providers = Object.assign(
    Object.create(null) as Record<string, unknown>,
    current.providers,
  );
  const owned = Object.create(null) as Record<string, { hash: string }>;
  for (const [id, entry] of Object.entries(ownership?.providers ?? {})) {
    const existing = providers[id];
    // 手工修改即丢失安全更新/删除的证据；整次事务失败，禁止悄悄消费旧内容。
    if (existing === undefined || hash(existing) !== entry.hash) {
      throw new Error(`Step CLI 供应商配置冲突（${id} 已被手工修改）；同步中止且未改动配置`);
    }
    if (!desired.has(id)) delete providers[id];
  }
  for (const [id, entry] of desired) {
    const existing = providers[id];
    if (
      existing !== undefined &&
      !Object.hasOwn(ownership?.providers ?? {}, id) &&
      hash(existing) !== hash(entry) &&
      !matchesLegacyProjection(existing, entry)
    ) {
      throw new Error(`Step CLI 供应商配置冲突（${id} 与手写配置同名）；同步中止且未改动配置`);
    }
    providers[id] = entry;
    owned[id] = { hash: hash(entry) };
  }
  // 空 desired 也先执行 ownership 协调；纯手写文件无需重写或接管。
  if (!ownership && desired.size === 0) return current;
  return {
    ...current,
    providers,
    [STEP_CLI_OWNERSHIP_KEY]: {
      version: 1,
      owner: "stepcode-desktop",
      providers: owned,
    } satisfies Ownership,
  };
}

/** 唯一 models.json writer：锁内重读、所有权校验、原子发布；错误不含配置或密钥。 */
export async function reconcileStepCliModelsFile(
  path: string,
  desired: ReadonlyMap<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const release = await acquireFileLock(path, [25, 50, 100, 200, 400], 100, 8_000);
    try {
      const current = await readCurrent(path);
      const next = reconcile(current, desired);
      if (canonical(current) === canonical(next)) return;
      try {
        await atomicWriteText(path, JSON.stringify(next, null, 2), { useFileLock: false });
        await chmod(path, 0o600).catch(() => undefined);
        return;
      } catch (error) {
        lastError = error;
      }
    } finally {
      await release();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Step CLI 模型配置发布失败");
}
