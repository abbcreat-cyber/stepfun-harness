import { fileURLToPath } from "node:url";
import { requiresProviderCommunication } from "./provider-communication.mjs";

export function isUnboundedContextRuleGoal(objective) {
  if (typeof objective !== "string") return false;
  const contextRule =
    /长期行为|行为约束|不是.{0,8}待办|每.{0,6}(?:轮|次).{0,12}(?:对话|提示|消息)|behavioral constraint|every.{0,12}(?:conversation|prompt|message)/i.test(
      objective,
    );
  const unbounded =
    /不要.{0,15}(?:完成|complete)|不.{0,8}标记.{0,8}完成|永不.{0,8}完成|never.{0,12}complet|not.{0,12}mark.{0,12}complet/i.test(
      objective,
    );
  return contextRule && unbounded;
}
export function withDesktopTaskContracts(command, options = {}) {
  const env = options.env ?? process.env;
  if (env.STEPCODE_TASK_MODE !== "desktop" || !requiresProviderCommunication(options))
    return command;
  const path = fileURLToPath(new URL("./extensions/desktop-task-contracts.mjs", import.meta.url));
  return command.includes(path) ? command : [...command, "--extension", path];
}
