/**
 * zcode-bridge 系列套件的桥接进程启动器（薄入口：委托 helpers.mjs 共享版 launchBridge）。
 *
 * 合并（R4 评审 low ⑩ / R4 建议 7 落地，2026-10-06）：本文件原是 zcode-bridge.mjs
 * 原样平移的 env 版启动器——状态目录经环境变量（带 P 前缀拼写，运行时与 zcode-bridge
 * 系套件一致）下发给桥接子进程，与 helpers.mjs 的共享版 launchBridge（--state-dir
 * argv 通道）长期并存；原头注释自称「不在此合并」，该注释已随本次合并删除并由此处
 * 委托取代。合并动机：宿主环境会间歇清洗 STECODE_* 前缀的环境变量——env 通道被清洗
 * 时桥接子进程拿不到状态目录而回退生产默认目录（~/.stepcode-desktop/bridge-state），
 * 隔离失效且跨进程持久化用例会超时，即存量挂死风险点；argv 通道不受该清洗影响。
 *
 * 行为变化：状态目录一律经 --state-dir argv 下发（桥接入口对未知参数容忍，且
 * session-router 把路由 argv 原样透传给 session worker）；既有调用点经 extraEnv
 * 环境键传状态目录的（sessions-index 与 attachments 的跨进程持久化用例）由 helpers
 * 的回退兼容识别（带 P / 不带 P 两种前缀拼写、运行时拼接）后转成 argv，套件文件
 * 无需改动。返回值在原 {child, frames, send, waitFor, stderr} 面上新增 stateDir；
 * 旧实现（env 版本地 launchBridge）已由本委托整体取代。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */

export { launchBridge } from "./helpers.mjs";
