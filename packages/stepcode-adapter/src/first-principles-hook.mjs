/** 已有规则由 SDK 加载；本扩展仅清理旧提醒，不再额外注入任何消息或指令。 */
export default function firstPrinciplesHook(pi) {
  // 只过滤我们旧扩展持久化的提醒，保留用户正文、其他扩展与原始会话文件。
  pi.on("context", (event) => ({
    messages: event.messages.filter(message => !(message.role === "custom" && message.customType === "first-principles")),
  }));
}
