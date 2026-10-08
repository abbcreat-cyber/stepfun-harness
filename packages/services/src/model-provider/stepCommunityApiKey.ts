/*
 * Step-Code (community) 的阶跃星辰 API Key 读取、校验与落盘。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 * Community-maintained integration; not affiliated with or endorsed by Z.ai.
 *
 * 关键约定（与 Step-Code CLI 对齐，改动前先读对端源码）：
 * - 开关：STEP_BACKEND=stepcode-local（canonical 字面量定义在 desktop main 的
 *   stepcodeBackend.ts；desktop → services 是唯一依赖方向，因此这里复制字面量并以注释互指）。
 * - Key 读取顺序：STEP_API_KEY 环境变量优先，否则读 CLI 的 ~/.stepcode/auth.json
 *   里 step.type === "api_key" 且 key 非空的条目（路径解析镜像 CLI 的 getStepAuthPath：
 *   STEPCODE_AUTH_PATH 覆盖 → STEP_CODING_AGENT_DIR 的父目录 → HOME/USERPROFILE + .stepcode）。
 * - 校验端点：GET https://api.stepfun.com/v1/models，与 CLI login-status 完全同款；
 *   401/403 → invalid，其余非 2xx / 网络异常 → network（断网不能锁人）。
 * - 服务端请求 URL 是代码内字面量；发请求前强制校验协议为 https 且 hostname 精确等于
 *   api.stepfun.com（不做后缀匹配），校验失败直接抛错、绝不发出请求。
 * - 日志纪律：校验与写盘路径只记 HTTP 状态码 / hostname / key 长度，绝不记 key 明文。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { STEP_API_KEY_ENV, type StepCommunityBalance } from "./stepCommunityModelSelection.js";

/** Step CLI 认的环境变量 key（STEP_API_KEY_ENV 的再导出，见 stepCommunityModelSelection.ts 的常量归属说明）。 */
export { STEP_API_KEY_ENV };

/** 与 Step CLI platform_cn profile 同源的 API base（字面量常量，不接受任何用户/配置/env 输入）。 */
const STEP_API_BASE_URL = "https://api.stepfun.com/v1";
/** 服务端请求唯一允许的 host 白名单（精确等于匹配，天然拒绝环回/私网/保留地址及一切其它 host）。 */
const STEP_API_ALLOWED_HOSTS: ReadonlySet<string> = new Set(["api.stepfun.com"]);
const STEP_API_VALIDATION_TIMEOUT_MS = 10_000;
const STEP_AUTH_FILE_NAME = "auth.json";
const STEP_AUTH_PROFILE_PLATFORM_CN = "platform_cn";
const STEP_CONFIG_DIR_DEFAULT = ".stepcode";
const STEP_AUTH_PATH_ENV = "STEPCODE_AUTH_PATH";
const STEP_CONFIG_DIR_ENV = "STEPCODE_CONFIG_DIR";
const STEP_AGENT_DIR_ENV = "STEP_CODING_AGENT_DIR";

type StepEnvRecord = Record<string, string | undefined>;

/** Step CLI 存 step 凭据的文件里 step 键的形状（只认 api_key 档；oauth 档不由桌面壳写入）。 */
export interface StepStoredApiKeyCredential {
  readonly key: string;
  readonly profile?: string;
}

/** key 可用性读取结果：source=none 表示 env 与 auth.json 都没有可用 key。 */
export interface StepApiKeySource {
  readonly key?: string;
  readonly source: "env" | "file" | "none";
  readonly connectionMode?: "api" | "subscription";
}

type ConnectionMode = "api" | "subscription";
type DesktopCredentials = { activeMode?: ConnectionMode; api?: { key: string }; subscription?: { key: string } };
export function readStepDesktopCredentials(env: StepEnvRecord): DesktopCredentials {
  const path = env.STEPCODE_DESKTOP_CREDENTIALS;
  if (!path) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) as DesktopCredentials; } catch { return {}; }
}

export async function writeStepDesktopCredential(env: StepEnvRecord, key: string, mode: ConnectionMode, options?: { activate?: boolean }): Promise<void> {
  const path = env.STEPCODE_DESKTOP_CREDENTIALS;
  if (!path) { if (mode === "api") return writeStepApiKeyToAuthFile(env, key); throw new Error("当前启动器尚未启用订阅接入"); }
  const existing = readStepDesktopCredentials(env);
  const next = { ...existing, activeMode: options?.activate === false ? existing.activeMode ?? mode : mode, [mode]: { key } };
  await atomicWriteText(path, JSON.stringify(next, null, 2));
  await chmod(path, 0o600).catch(() => undefined);
}

export async function readStepDisplayName(env: StepEnvRecord): Promise<string> {
  const root = env.STEPCODE_STORAGE_ROOT_DIR || join(homedir(), ".stepcode-desktop");
  try {
    const data = JSON.parse(await readFile(join(root, "profile.json"), "utf8")) as { displayName?: string };
    return data.displayName?.trim() || "阶跃星辰用户";
  } catch { return "阶跃星辰用户"; }
}

export async function writeStepDisplayName(env: StepEnvRecord, name: string): Promise<string> {
  const displayName = name.trim();
  if (!displayName || Array.from(displayName).length > 24 || /[\u0000-\u001f\u007f]/u.test(displayName)) throw new Error("请输入 1–24 个字符的名字，不使用换行或控制字符");
  const root = env.STEPCODE_STORAGE_ROOT_DIR || join(homedir(), ".stepcode-desktop");
  await atomicWriteText(join(root, "profile.json"), JSON.stringify({ displayName }));
  return displayName;
}

/** 校验结果。validity 语义与 CLI login-status 一致：仅 401/403 视为 invalid，其余故障均 network。 */
export interface StepApiKeyValidationResult {
  readonly validity: "valid" | "invalid" | "network";
  /** 仅用于日志与诊断回显（HTTP 状态码），不含任何凭据内容。 */
  readonly httpStatus: number | null;
  /** 网络类错误的异常名（只记 name，不记可能携带 URL 的 message）。 */
  readonly errorName?: string;
  /**
   * 校验 200 时从同一响应体顺带解析出的模型 id 清单（GET /models 的 data[].id；可能为空数组）。
   * 可选字段：body 缺失/非 JSON/data 非数组时为 undefined——模型探测失败绝不影响 validity 结论。
   * 复用本次校验请求的响应体，零新增网络调用。
   */
  readonly modelIds?: readonly string[];
}

/** 镜像 Step-Code CLI step/environment.ts 的 home 解析。 */
function resolveStepHomeDir(env: StepEnvRecord): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function resolveStepConfigDir(env: StepEnvRecord): string {
  return env[STEP_CONFIG_DIR_ENV]?.trim() || STEP_CONFIG_DIR_DEFAULT;
}

/** 镜像 CLI resolveStepConfigRoot：显式 agent dir 覆盖时取其父目录（文件系统根安全）。 */
function resolveStepConfigRoot(env: StepEnvRecord): string {
  const override = env[STEP_AGENT_DIR_ENV]?.trim();
  if (!override) return join(resolveStepHomeDir(env), resolveStepConfigDir(env));
  const agentDir = resolve(override);
  const parent = dirname(agentDir);
  return parent === agentDir ? agentDir : parent;
}

/** 镜像 CLI step/auth.ts 的 getStepAuthPath（含 STEPCODE_AUTH_PATH 覆盖）。 */
export function resolveStepAuthFilePath(env: StepEnvRecord): string {
  return env[STEP_AUTH_PATH_ENV]?.trim() || join(resolveStepConfigRoot(env), STEP_AUTH_FILE_NAME);
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * auth.json 可能被 CLI（proper-lockfile 下的读-改-写）在两次读取之间重写；
 * 按文件内容 sha256 缓存解析结果，避免同秒重写被误判成旧快照（对齐 CLI auth-storage 的 content-digest 策略）。
 */
const authFileCredentialCache = new Map<
  string,
  { contentSha: string; value: StepStoredApiKeyCredential | undefined }
>();

function readStepStoredApiKey(authPath: string): StepStoredApiKeyCredential | undefined {
  let content: string;
  try {
    content = readFileSync(authPath, "utf8");
  } catch {
    return undefined;
  }
  const digest = sha256(content);
  const cached = authFileCredentialCache.get(authPath);
  if (cached && cached.contentSha === digest) return cached.value;

  let credential: StepStoredApiKeyCredential | undefined;
  try {
    const parsed = JSON.parse(stripBom(content)) as Record<string, unknown>;
    const step = parsed.step;
    if (step && typeof step === "object" && !Array.isArray(step)) {
      const record = step as Record<string, unknown>;
      if (
        record.type === "api_key" &&
        typeof record.key === "string" &&
        record.key.trim().length > 0
      ) {
        credential = {
          key: record.key.trim(),
          ...(typeof record.profile === "string" && record.profile.trim()
            ? { profile: record.profile.trim() }
            : {}),
        };
      }
    }
  } catch {
    // 畸形 JSON 等价于没有可用 step key；落盘写入路径会单独对畸形文件显式报错。
  }
  authFileCredentialCache.set(authPath, { contentSha: digest, value: credential });
  return credential;
}

/** env 的 STEP_API_KEY 优先；否则读 auth.json 的 step api_key 条目。 */
export function readStepApiKey(env: StepEnvRecord): StepApiKeySource {
  const credentials = readStepDesktopCredentials(env);
  const mode = credentials.activeMode;
  if ((mode === "api" || mode === "subscription") && credentials[mode]?.key) {
    return { key: credentials[mode]!.key, source: "file", connectionMode: mode };
  }
  const envKey = env[STEP_API_KEY_ENV]?.trim();
  if (envKey) return { key: envKey, source: "env" };
  const stored = readStepStoredApiKey(resolveStepAuthFilePath(env));
  if (stored?.key) return { key: stored.key, source: "file" };
  return { key: undefined, source: "none" };
}

/** 独立读取指定计费通道；余额/新模型不能再借 activeMode 把 API Key 换成订阅 Key。 */
export function readStepConnectionKey(env: StepEnvRecord, mode: ConnectionMode): StepApiKeySource {
  const key = readStepDesktopCredentials(env)[mode]?.key?.trim();
  if (key) return { key, source: "file", connectionMode: mode };
  if (mode === "subscription") return { source: "none", connectionMode: mode };
  const envKey = env[STEP_API_KEY_ENV]?.trim();
  if (envKey) return { key: envKey, source: "env", connectionMode: mode };
  const stored = readStepStoredApiKey(resolveStepAuthFilePath(env));
  if (stored?.key && !stored.profile?.includes("plan")) return { key: stored.key, source: "file", connectionMode: mode };
  return { source: "none", connectionMode: mode };
}

/**
 * 发请求前强制校验 URL：仅允许 https，且 hostname 必须精确等于白名单成员。
 * 白名单外的 host（含 localhost/环回/私网/保留地址、以及 api.stepfun.com 的任何子域/变体写法）一律抛错、不发请求。
 */
export function assertStepApiUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("非法的阶跃星辰 API 地址：URL 无法解析");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`阶跃星辰 API 地址仅允许 https，当前协议 ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!STEP_API_ALLOWED_HOSTS.has(hostname)) {
    throw new Error(`阶跃星辰 API 地址 host 不在白名单内: ${hostname}`);
  }
  return parsed;
}

/**
 * 用 GET {base}/models 校验 key。与 Step CLI login-status.ts 完全同款：
 * 401/403 → invalid；其余非 2xx 与网络异常（含超时）→ network。
 * 校验成功时顺带从同一响应体解析 /models 的模型 id 清单（modelIds，零新增网络调用），
 * 供调用方做已知可用模型的第一层探测（注意：/models 在列 ≠ 套餐一定能聊）。
 * 注意 key 绝不出现在返回值或任何调用方日志里。
 */
export async function validateStepApiKey(
  key: string,
  options?: { fetchImpl?: typeof fetch; connectionMode?: ConnectionMode },
): Promise<StepApiKeyValidationResult> {
  const trimmed = key.trim();
  if (!trimmed) return { validity: "invalid", httpStatus: null };
  const url = assertStepApiUrl(options?.connectionMode === "subscription"
    ? "https://api.stepfun.com/step_plan/v1/models" : `${STEP_API_BASE_URL}/models`);
  try {
    const response = await (options?.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(STEP_API_VALIDATION_TIMEOUT_MS),
      // host 白名单只校验本字面量 URL，不覆盖 fetch 重定向后的目标；
      // redirect:"error" 让任何 3xx 直接抛错（归一为 network），请求头绝无机会被携带到重定向目标。
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      return { validity: "invalid", httpStatus: response.status };
    }
    if (!response.ok) return { validity: "network", httpStatus: response.status };
    // 模型清单探测（best-effort）：解析失败/无 body → modelIds undefined，不影响 validity。
    let modelIds: readonly string[] | undefined;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
        modelIds = (body as { data: readonly unknown[] }).data
          .map((entry) =>
            entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined,
          )
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
      }
    } catch {
      // 无 body / 非 JSON：探测失败，key 校验结论不受影响。
    }
    return modelIds === undefined
      ? { validity: "valid", httpStatus: response.status }
      : { validity: "valid", httpStatus: response.status, modelIds };
  } catch (error) {
    return {
      validity: "network",
      httpStatus: null,
      errorName: error instanceof Error ? error.name : undefined,
    };
  }
}

/**
 * 用 GET {base}/accounts 拉取阶跃星辰账户余额（docs/step-account-balance-spec.md 的 host 服务层契约）。
 *
 * 为什么不复用 validateStepApiKey：两条链路的响应体、失败分类与可解析字段完全不同
 * （/models 只判 valid/invalid/network 顺带探模型清单；/accounts 要给出账户类型与三类原始金额），
 * 合在一个函数里会让「校验 key」和「读余额」两种语义纠缠，出故障时也无法分别定位。
 *
 * 语义（契约原文，不得自行增删）：
 * - 空 key 直接返回 no-key 且不发请求（调用方已按 readStepApiKey().source 判过，这里是兜底）。
 * - URL 复用 assertStepApiUrl 白名单强校验、redirect:"error"、超时与 /models 同款 10s。
 * - 401/403 → invalid（key 失效）；其余非 2xx / fetch 抛错 / 超时 → network（后者附 errorName）。
 * - 响应体非 object（含数组、JSON null、非 JSON）→ network：绝不猜结构、绝不给兜底金额。
 * - 只解析 type/balance/total_cash_balance/total_voucher_balance；金额必须 Number.isFinite
 *   且 >= 0，否则舍弃该字段，绝不让脏值变成 UI 上的数字。
 *
 * 日志纪律：本函数不做任何日志（key 长度等上下文在宿主侧 service 边界记录），
 * 绝不记 key 明文，绝不记余额金额。
 */
export async function fetchStepAccountBalance(
  key: string,
  options?: { fetchImpl?: typeof fetch },
): Promise<StepCommunityBalance> {
  const trimmed = key.trim();
  if (!trimmed) return { status: "no-key", httpStatus: null };
  const url = assertStepApiUrl(`${STEP_API_BASE_URL}/accounts`);
  try {
    const response = await (options?.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(STEP_API_VALIDATION_TIMEOUT_MS),
      // 与 validateStepApiKey 同款：host 白名单只校验本字面量 URL，覆盖不到重定向目标；
      // redirect:"error" 让任何 3xx 直接抛错（归一为 network），Authorization 头绝无机会被带到重定向目标。
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", httpStatus: response.status };
    }
    if (!response.ok) {
      return { status: "network", httpStatus: response.status };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // 响应体非 JSON：按 network 处理，绝不猜结构、绝不给兜底金额。
      return { status: "network", httpStatus: response.status };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: "network", httpStatus: response.status };
    }
    const record = body as Record<string, unknown>;
    // 契约只解析 type/balance/total_cash_balance/total_voucher_balance 四个原始字段；
    // 响应体里的 object 等其余字段一律不消费、不进返回值——host 只做原始投影，不派生合计、
    // 不折算、也不按未写入契约的字段做强校验（上游改字段名时不应误报 network）。
    const accountType =
      record.type === "prepaid" || record.type === "postpaid" ? record.type : undefined;
    const balance = readNonNegativeAmount(record.balance);
    const totalCashBalance = readNonNegativeAmount(record.total_cash_balance);
    const totalVoucherBalance = readNonNegativeAmount(record.total_voucher_balance);
    return {
      status: "ok",
      httpStatus: response.status,
      ...(accountType !== undefined ? { accountType } : {}),
      ...(balance !== undefined ? { balance } : {}),
      ...(totalCashBalance !== undefined ? { totalCashBalance } : {}),
      ...(totalVoucherBalance !== undefined ? { totalVoucherBalance } : {}),
    };
  } catch (error) {
    // 只归一异常名（不记可能携带 URL 的 message）；含 AbortSignal.timeout 触发的超时。
    return {
      status: "network",
      httpStatus: null,
      errorName: error instanceof Error ? error.name : undefined,
    };
  }
}

/**
 * 只接受有限且非负的金额。
 * 负数 / NaN / ±Infinity / 非 number 一律返回 undefined（舍弃该字段）：
 * 契约要求这些值绝不能变成 UI 上的数字，宁可缺省走 empty 占位，也不能显示一个算不出来的数。
 */
function readNonNegativeAmount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 读-合并-写 CLI 的 auth.json：只替换顶层 "step" 键为
 * { type: "api_key", key, profile: "platform_cn" }，保留其它 provider 键。
 * profile=platform_cn 让 CLI 把它识别为大陆 API key 登录档。
 * 畸形的既有文件不会被静默覆盖（会丢失其它 provider 凭据），显式报中文错误。
 */
export async function writeStepApiKeyToAuthFile(env: StepEnvRecord, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API Key 不能为空");
  const authPath = resolveStepAuthFilePath(env);

  const readCurrent = async (): Promise<Record<string, unknown>> => {
    if (!existsSync(authPath)) return {};
    const raw = await readFile(authPath, "utf8");
    try {
      const parsed: unknown = JSON.parse(stripBom(raw));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error(`阶跃星辰凭据文件已损坏（${authPath}），请人工检查后再写入`);
    }
  };

  // 写前重读 + 失败重试一次：与 CLI 的 proper-lockfile 写入存在小窗口竞态时靠重读收敛。
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readCurrent();
    const next: Record<string, unknown> = {
      ...current,
      step: { type: "api_key", key: trimmed, profile: STEP_AUTH_PROFILE_PLATFORM_CN },
    };
    try {
      await atomicWriteText(authPath, JSON.stringify(next, null, 2));
      // 与 CLI 同款 0600 收紧（best-effort；Windows 上无实际意义）。
      await chmod(authPath, 0o600).catch(() => undefined);
      // 写盘成功后立即失效并重建读缓存，保证同进程后续 readStepApiKey 立即看到新 key。
      authFileCredentialCache.delete(authPath);
      readStepStoredApiKey(authPath);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 仅供测试重置进程内读缓存。 */
export function resetStepAuthFileCredentialCacheForTest(): void {
  authFileCredentialCache.clear();
}
