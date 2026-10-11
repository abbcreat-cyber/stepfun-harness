const modes = new Set(["build", "edit", "plan", "yolo"]);
export function acceptedPermissionMode(requested, previous = "build") {
  if (requested === undefined) return modes.has(previous) ? previous : "build";
  if (!modes.has(requested)) throw new Error("不支持的权限模式");
  return requested;
}
/** 只识别 Step 原生的工具授权，不把 AskUserQuestion 等业务问题当权限放行。 */
export function isNativeToolPermission(request) {
  return nativeToolPermissionCallId(request) !== null;
}

export function nativeToolPermissionCallId(request) {
  if (request.method !== "confirm") return null;
  const title = /^(?:Approve|Dangerous) [\w.-]+ \[([^\]]+)\]$/.exec(request.title ?? "");
  const call = /^Call: (\S+)\r?\n/.exec(request.message ?? "");
  return title && call && call[1].endsWith(title[1]) ? call[1] : null;
}

/*
 * 四模式语义表（P0-05，桥接侧策略；底座 argv 固定，理由见 approvalModeSpawnCommands）：
 *
 *   模式   | 底座 argv（主会话） | 原生工具权限（isNativeToolPermission）      | 普通业务 confirm/追问
 *   -------+--------------------+---------------------------------------------+---------------------
 *   build  | --approval-mode    | 弹窗（allow/deny）                          | 弹窗
 *   edit   |      confirm       | 弹窗——与 build 逐字段同行为（UI 四模式语义  | 弹窗
 *          |                    | 在权限维度无差异，edit 的差异只在宿主文案） |
 *   plan   | （同上，不随模式   | 直接拒 {confirmed:false}，不建弹窗          | 弹窗
 *          |   换 argv）        |                                             |
 *   yolo   |                    | 放行 {confirmed:true}                       | 弹窗（业务问题不放行）
 *
 * plan 的诚实边界：拒绝文案是 confirmed:false（底座把它当「用户拒绝」），模型看不到
 * 底座原生 strict 档的 'Read-only mode blocks' 文案。原生 strict 的免费文案只在
 * 「全程 plan 不切档」时可获得（初始 spawn strict + 切档重启底座），列为后续优化。
 */

/**
 * 会话模式 → 原生工具授权的桥接动作。只对 isNativeToolPermission 命中的请求生效；
 * 业务问题恒 "ask"（弹窗），yolo 也不放行普通追问。
 * @param {string | undefined} mode 会话权限模式（build/edit/plan/yolo；未知按 fail-safe 弹窗）
 * @param {any} request 扩展 UI 请求
 * @returns {"allow" | "deny" | "ask"}
 */
export function resolveNativePermissionAction(mode, request) {
  if (!isNativeToolPermission(request)) return "ask";
  if (mode === "yolo") return "allow";
  if (mode === "plan") return "deny";
  return "ask";
}

/**
 * 给底座 spawn 命令追加 --approval-mode（两种已有形态任一命中即原样返回，不二次追加）：
 * 精确 token（…、"--approval-mode"、"confirm"）与前缀形态（"--approval-mode=auto"）。
 * 非数组/空数组原样返回（无可追加的宿主命令）。
 * @param {string[] | any} command
 * @param {string} mode
 * @returns {string[] | any}
 */
export function withApprovalModeArgs(command, mode) {
  if (!Array.isArray(command) || command.length === 0) return command;
  const preset = command.some(
    (token) => token === "--approval-mode" || (typeof token === "string" && token.startsWith("--approval-mode=")),
  );
  return preset ? command : [...command, "--approval-mode", mode];
}

/**
 * 桥接进程的两份底座 spawn 命令装配（P0-05）：
 *
 * - 主会话底座固定 confirm（Mode: Ask）。真理由：模式可会话中途切（switchCollaborationMode
 *   只改 session.mode 不动底座），底座又没有运行时切档命令——若按初始模式定 argv，
 *   切档后必然脱节（plan(strict) 切 build 仍被底座拒、yolo(auto) 切 build 静默放行）；
 *   修复脱节需要切档重启底座（后续优化，P0 不做）。故四模式差异全部落在桥接
 *   permission 策略（resolveNativePermissionAction）。
 * - 工作流 actor 底座固定 auto（Bypass）。actor 有独立 spawn 通道（step-driver 每 actor
 *   自建 client），auto 保持今天后台实际行为（默认档 bypass）不回归：普通写静默放行、
 *   不发请求；危险命令仍会 confirm 弹到桥接、按主会话模式裁决。
 *
 * 底座是每会话 worker 独占进程（session-router 按 key spawn、idle 回收），两份命令
 * 互不影响。
 * @param {string[]} baseCommand
 * @returns {{ spawnCommand: string[], actorSpawnCommand: string[] }}
 */
export function approvalModeSpawnCommands(baseCommand) {
  return {
    spawnCommand: withApprovalModeArgs(baseCommand, "confirm"),
    actorSpawnCommand: withApprovalModeArgs(baseCommand, "auto"),
  };
}

/**
 * setStatus(step-permission) 档位回执探针（纯函数，便于单测注入）：
 * 底座启动后免费回执当前权限档位；主会话底座期望 'Mode: Ask'。非 Ask 说明底座
 * 静默退回了别的档位（如旧版底座默认 bypass——桥接 argv 未生效），返回告警文本；
 * 缺帧/缺 statusText（cleared）/其他 statusKey 一律容忍（返回 null）。
 * 兼作真机验收断言探针（rpc-approval.mjs 实证 extension_ui_request 帧可达 onEvent）。
 * @param {any} event 客户端事件流的单帧
 * @returns {string | null}
 */
export function stepPermissionStatusWarning(event) {
  if (
    event?.type !== "extension_ui_request" ||
    event.method !== "setStatus" ||
    event.statusKey !== "step-permission"
  )
    return null;
  const statusText = typeof event.statusText === "string" ? event.statusText : "";
  if (!statusText || /^Mode:\s*Ask\b/.test(statusText)) return null;
  return `主会话底座权限档位回执异常：${statusText}（期望 Mode: Ask；--approval-mode confirm 可能未生效）`;
}
