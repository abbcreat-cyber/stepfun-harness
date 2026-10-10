/**
 * 测试聚合入口。
 *
 * 用途：让 `node --test <本目录>`（目录形式，Node 24 把位置参数按 glob/文件解析，
 * 裸目录需要 index.js 才能被模块解析命中）可以直接跑全部套件：
 *
 *   node --test test            （相对包目录）
 *   node --test test/           （尾斜杠同样可用）
 *
 * 真实套件放在包根的 suites/ 目录（文件名不带 .test. 后缀、也不在 test/ 目录内），
 * 因此 `node --test`（无参数的默认扫描：全仓库 *.test.* + test/ 目录递归）只会经由
 * 本文件加载一遍，不会重复执行。
 */

import "../suites/jsonl.mjs";
import "../suites/initial-session.mjs";
import "../suites/workflow-empty-read.mjs";
import "../suites/workflow-snippet-compat.mjs";
import "../suites/workflow-plugin-upgrade.mjs";
import "../suites/rpc-command-roundtrip.mjs";
import "../suites/rpc-streaming.mjs";
import "../suites/rpc-approval.mjs";
import "../suites/rpc-lifecycle.mjs";
// zcode-bridge 套件按主题拆分（原单文件超 max-lines），用例原样分布在这些同族文件里。
import "../suites/zcode-bridge.mjs";
import "../suites/zcode-bridge-topics.mjs";
import "../suites/zcode-bridge-errors.mjs";
import "../suites/zcode-bridge-sessions-index.mjs";
import "../suites/zcode-bridge-turns.mjs";
import "../suites/zcode-bridge-attachments.mjs";

import "../suites/usage-stats.mjs";
import "../suites/stream-projection.mjs";
import "../suites/plugins.mjs";
import "../suites/official-plugins.mjs";
import "../suites/session-plugin-catalog.mjs";
import "../suites/embedded-browser.mjs";
import "../suites/browser-open-retention.mjs";

import "../suites/workflow.mjs";
import "../suites/workflow-snippet-lifecycle.mjs";

import "../suites/session-statistics.mjs";

import "../suites/permission-drafts.mjs";
// P0-05：input/select → userInput pending 的桥接语义与四路兜底（close 第四路）。
import "../suites/interaction-resolve.mjs";
// P0-05：协议级模式分支（yolo 放行/plan 拒绝）与 mock:input/mock:select 往返。
import "../suites/rpc-interactions.mjs";
import "../suites/desktop-questionnaire.mjs";
import "../suites/desktop-automation.mjs";
import "../suites/desktop-automation-native.mjs";
import "../suites/desktop-automation-workflow-origin.mjs";
import "../suites/task-rule-guard.mjs";
import "../suites/task-rules-native.mjs";
import "../suites/extension-config-signature.mjs";
import "../suites/assistant-text.mjs";
import "../suites/workflow-speed.mjs";
import "../suites/attachments.mjs";

import "../suites/input-admission-first-input.mjs";
import "../suites/input-admission-queue.mjs";
import "../suites/capability-consistency.mjs";
import "../suites/send-model-selection.mjs";
import "../suites/queue-model-deferred.mjs";
import "../suites/sessions-index-keying.mjs";
import "../suites/v4-createsession-workspace-id.mjs";
// P1-01 桥接侧：renameSession 四落点一致 + 防覆盖守卫；deleteSession intent 双语义
//（draftCleanup 向后兼容 / userDelete 先归档后索引 + 墓碑防复活）。
import "../suites/v4-session-rename.mjs";
import "../suites/v4-session-delete.mjs";
import "../suites/bridge-log-file.mjs";
// R6 字面量清除：env 键运行时拼接的三条 env-only 回归（state-dir/storage-root/session-worker）。
import "../suites/env-literal-passthrough.mjs";
// R8-3 修复轮：个人供应商凭据同步进 CLI models.json 的协议级行为（经 STEP_MOCK_MODELS_FILE 晚绑定注入面）。
import "../suites/cli-provider-sync.mjs";
import "../suites/custom-provider-bridge.mjs";
// R6 挂载（第五轮评审 medium ②）：shared 包协议级透传防线挂进本聚合门禁。
// shared/src 全树是 TS 的 .js 扩展名 import 惯例，纯 node --test 无法跨包直引
// （ERR_MODULE_NOT_FOUND），故经 tsx 子进程包装（见该 suite 头注释），
// 使「声明被删必红」随全量套件自动执行。
import "../suites/shared-passthrough.mjs";
import "../suites/managed-followup.mjs";
import "../suites/stop-persistence.mjs";
import "../suites/session-model-recovery.mjs";
import "../suites/workflow-settings.mjs";
import "../suites/tool-repair-context.mjs";
import "../suites/tool-repair-native.mjs";
import "../suites/workflow-visibility.mjs";
import "../suites/workflow-activity.mjs";
import "../suites/workflow-guide-wire.mjs";
import "../suites/workflow-complete.mjs";
import "../suites/mini-activity-summary.mjs";
import "../suites/desktop-shell.mjs";
import "../suites/official-plugin-cancellation.mjs";
import "../suites/official-browser-cancellation.mjs";
import "../suites/official-plugin-working-directory.mjs";
import "../suites/plugin-cwd-toggle.mjs";
import "../suites/provider-wire-contract.mjs";
import "../suites/runtime-preparation.mjs";
import "../suites/workspace-reference.mjs";
import "../suites/rpc-startup-readiness.mjs";
import "../suites/plugin-startup-signature.mjs";
import "../suites/provider-communication-hooks.mjs";
import "../suites/provider-wire-tool-integrity.mjs";
import "../suites/provider-wire-owner.mjs";
import "../suites/provider-request-options.mjs";
import "../suites/provider-tool-integrity.mjs";
import "../suites/provider-options-carry.mjs";
import "../suites/provider-command-boundary.mjs";
import "../suites/provider-wire-final-retry.mjs";
import "../suites/provider-wire-final-host.mjs";
import "../suites/desktop-command-deadline.mjs";
import "../suites/desktop-command-deadline-native.mjs";
import "../suites/desktop-input-context.mjs";
import "../suites/desktop-plugin-context.mjs";
import "../suites/desktop-input-context-native.mjs";
import "../suites/assistant-communication-native.mjs";
import "../suites/assistant-opening-hook.mjs";
import "../suites/browser-context-contract.mjs";
import "../suites/assistant-opening-native.mjs";
import "../suites/plugin-discovery-native.mjs";
import "../suites/builtin-hooks-native.mjs";
import "../suites/marketplace-refresh.mjs";
import "../suites/builtin-plugin-availability.mjs";
import "../suites/android-windows-tools.mjs";
