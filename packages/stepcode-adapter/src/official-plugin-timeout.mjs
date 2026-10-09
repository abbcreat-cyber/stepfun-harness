/** 工具自己的执行期限先到，桥接层留出启动/收尾余量；同时支持原版 camelCase。 */
export function officialPluginCallTimeout(plugin, tool, args = {}) {
  const requested = args.timeout_ms ?? args.timeoutMs;
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0 || requested > 3600000)) throw new Error("工具 timeout 必须为 1–3600000 毫秒");
  if (plugin !== "android-emulator") return requested ?? 120000;
  const build = ["android_build_app", "android_build_and_run"].includes(tool);
  const own = requested ?? (build ? 600000 : 180000);
  // build 可能先生成 Gradle wrapper（120 秒），build_and_run 还要启动设备/安装。
  return own + (tool === "android_build_and_run" ? 360000 : build ? 150000 : 30000);
}
