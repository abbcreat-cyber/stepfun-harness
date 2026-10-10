/** 恢复会话时直接启动目标文件，避免先建空底座再 switch_session 重载整套扩展。 */
export function sessionStartupCommand(command, sessionFile) {
  if (!sessionFile) return command;
  const args = [];
  for (let i = 0; i < command.length; i++) {
    const arg = command[i];
    if (arg === "--session" || arg === "-s") { i++; continue; }
    if (arg === "--no-session" || arg === "--resume" || arg.startsWith("--session=")) continue;
    args.push(arg);
  }
  return [...args, "--session", sessionFile];
}
