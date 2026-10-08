/*
 * Step-Code community backend switch for the ZCode desktop shell.
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 * Community-maintained integration; not affiliated with or endorsed by Z.ai.
 *
 * 纯加法开关：仅当 STEP_BACKEND=stepcode-local 时，把仓库现成的 agent 命令
 * 覆盖机制（ZCODE_AGENT_SERVER_COMMAND / ZCODE_AGENT_SERVER_ARGS_JSON，见
 * zcodeAgentProcessManager.resolveDefaultZCodeAgentCommand 的最高优先分支）
 * 指向 stepcode-adapter 的 ZCode Protocol 门面进程（bin/zcode-bridge.mjs）。
 * 默认（不设 STEP_BACKEND 或设为其他值）返回空对象，Z.ai 官方 agent 链路
 * 一字不改。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

/** 开关键与取值（任务约定：STEP_BACKEND=stepcode-local 启用社区后端）。 */
export const STEPCODE_BACKEND_ENV = "STEP_BACKEND";
export const STEPCODE_BACKEND_VALUE = "stepcode-local";

/** 用户可见的社区后端名（中性命名，不冒充官方）。 */
export const STEPCODE_COMMUNITY_BACKEND_LABEL = "Step-Code (community)";

/** 门面进程在 monorepo 内的默认位置（可用 STEPCODE_BRIDGE_ENTRY 覆盖）。 */
const DEFAULT_BRIDGE_RELATIVE_ENTRY = "packages/stepcode-adapter/bin/zcode-bridge.mjs";

type HostProcessLocalEnv = Record<string, string | undefined>;

function readTrimmedEnv(name: string, localEnv: HostProcessLocalEnv): string | undefined {
  return process.env[name]?.trim() || localEnv[name]?.trim() || undefined;
}

/** 与 desktopRuntimeEnv 的 .env 定位同规则：向上找 pnpm-workspace.yaml 即仓库根。 */
function findMonorepoWorkspaceRoot(): string | null {
  let current = resolve(import.meta.dirname, "../..");
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function parseStringArrayEnv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export interface StepCodeCommunityBackendStatus {
  enabled: boolean;
  reason: "off" | "explicit-command-override" | "packaged-runtime" | "bridge-missing" | "on";
  bridgeEntry?: string;
  command?: string;
}

/** 供日志/诊断消费的解析结果（与 env 注入同一判定逻辑）。 */
export function resolveStepCodeCommunityBackendStatus(
  hostProcessLocalEnv: HostProcessLocalEnv,
): StepCodeCommunityBackendStatus {
  if (readTrimmedEnv(STEPCODE_BACKEND_ENV, hostProcessLocalEnv) !== STEPCODE_BACKEND_VALUE) {
    return { enabled: false, reason: "off" };
  }
  // ZCODE_AGENT_SERVER_COMMAND 是仓库现成的显式覆盖口，用户显式设置时永远优先。
  if (readTrimmedEnv("ZCODE_AGENT_SERVER_COMMAND", hostProcessLocalEnv)) {
    return { enabled: false, reason: "explicit-command-override" };
  }
  // 门面未打进安装包（bundled-agents 仅含官方 runtime），因此打包态不做 workspace fallback：
  // 只有显式 STEPCODE_BRIDGE_ENTRY 才能放行打包态社区后端（启动器注入该键）；未提供时
  // 维持 packaged-runtime 回落官方链路。开发态保留 monorepo 根的默认门面路径。
  const packaged = isElectronAppPackaged();
  const explicitBridgeEntry = readTrimmedEnv("STEPCODE_BRIDGE_ENTRY", hostProcessLocalEnv);
  const workspaceRoot = packaged ? null : findMonorepoWorkspaceRoot();
  const bridgeEntry =
    explicitBridgeEntry ??
    (workspaceRoot ? join(workspaceRoot, DEFAULT_BRIDGE_RELATIVE_ENTRY) : undefined);
  if (!bridgeEntry) {
    return { enabled: false, reason: packaged ? "packaged-runtime" : "bridge-missing" };
  }
  if (!existsSync(bridgeEntry)) {
    return { enabled: false, reason: "bridge-missing", bridgeEntry };
  }
  return {
    enabled: true,
    reason: "on",
    bridgeEntry,
    command: readTrimmedEnv("STEPCODE_NODE", hostProcessLocalEnv) ?? "node",
  };
}

/**
 * STEP_BACKEND=stepcode-local 时返回要注入 Host 进程的 agent 命令覆盖 env；
 * 其余情况返回空对象（默认行为零变化）。
 *
 * 注入的键不在 sanitizeZCodeRuntimeEnv 剔除名单（shared/src/runtimeEnv.ts
 * SANITIZED_RUNTIME_ENV_KEYS），会随 Host env 被 zcodeAgentProcessManager 的
 * spawn 继承并由 resolveDefaultZCodeAgentCommand 以最高优先级消费；桌面侧会
 * 自动追加 `--surface desktop`（applyPresentationSurfaceToCommand），门面已
 * 容忍该参数。
 */
export function resolveStepCodeCommunityBackendEnv(
  hostProcessLocalEnv: HostProcessLocalEnv,
): Record<string, string> {
  const status = resolveStepCodeCommunityBackendStatus(hostProcessLocalEnv);
  if (!status.enabled || !status.bridgeEntry || !status.command) {
    if (status.reason !== "off") {
      console.warn(
        `[${STEPCODE_COMMUNITY_BACKEND_LABEL}] ${STEPCODE_BACKEND_ENV}=${STEPCODE_BACKEND_VALUE} requested but inactive (${status.reason}); falling back to the default ZCode agent backend.`,
      );
    }
    return {};
  }
  const extraArgs = parseStringArrayEnv(
    readTrimmedEnv("STEPCODE_BRIDGE_ARGS_JSON", hostProcessLocalEnv),
  );
  // 断点7 防静默假对话：桥接门面在未传 --step-cli 时会回落驱动本包 mock（step-rpc-mock），
  // extraArgs 为空几乎必然意味着 mock 假回复，必须显式 warn 而不是静默放行。
  if (extraArgs.length === 0) {
    console.warn(
      `[${STEPCODE_COMMUNITY_BACKEND_LABEL}] STEPCODE_BRIDGE_ARGS_JSON is empty; the bridge will fall back to the bundled mock Step backend (fake replies). Pass --step-cli via STEPCODE_BRIDGE_ARGS_JSON to drive the real Step CLI.`,
    );
  }
  console.info(
    `[${STEPCODE_COMMUNITY_BACKEND_LABEL}] agent backend switched via ${STEPCODE_BACKEND_ENV}=${STEPCODE_BACKEND_VALUE}: ${status.command} ${status.bridgeEntry}`,
  );
  return {
    ZCODE_AGENT_SERVER_COMMAND: status.command,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([status.bridgeEntry, ...extraArgs]),
    STEPCODE_OFFICIAL_PLUGIN_SOURCE: readTrimmedEnv("STEPCODE_OFFICIAL_PLUGIN_SOURCE", hostProcessLocalEnv)
      ?? (isElectronAppPackaged() ? join(process.resourcesPath, "step-official-plugins") : join(import.meta.dirname, "../../build/step-official-plugins")),
  };
}
