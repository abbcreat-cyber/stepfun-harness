/** 展示品牌与内部协议/磁盘格式分离，避免改名破坏旧会话和上游兼容性。 */
export function isStepCommunityProduct(): boolean {
  return (typeof process !== "undefined" && process.env.STEP_BACKEND === "stepcode-local") ||
    (import.meta as ImportMeta & { env?: { VITE_STEPCODE_COMMUNITY?: string } }).env?.VITE_STEPCODE_COMMUNITY === "1";
}

export function formatStepCommunityProductText(text: string, enabled = isStepCommunityProduct()): string {
  // 只改独立的产品词，不改 URL、.zcode 目录、代码标识、命令和用户插值。
  return enabled ? text.replace(/(?<![\w./:@`-])ZCode(?![\w./:@`-])/g, "Step Code") : text;
}
