/** reset 已生成独立新客户端；CLI 启动自带空会话，无需再次运行 session_start 插件。 */
export async function initializeCreatedSession(client, command = []) {
  const resumesHistory = command.some(arg => /^(?:--(?:session|resume|continue)(?:=|$)|-[cr]$)/.test(arg));
  if (!client.initialSessionClaimed && !resumesHistory) {
    const state = await client.getState();
    if (state.messageCount === 0 && state.pendingMessageCount === 0 &&
      state.isStreaming === false && state.isCompacting === false &&
      (await client.getMessages()).length === 0) {
      client.initialSessionClaimed = true;
      return;
    }
  }
  await client.newSession();
  client.initialSessionClaimed = true;
}
