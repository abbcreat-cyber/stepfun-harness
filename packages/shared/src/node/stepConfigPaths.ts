import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface StepConfigPaths {
  readonly root: string;
  readonly agentDir: string;
  readonly modelsFile: string;
}

/** Writer、配置签名和子进程共用路径；绝对 config dir 不能再次拼进 HOME。 */
export function resolveStepConfigPaths(
  env: Readonly<Record<string, string | undefined>>,
): StepConfigPaths {
  const explicitAgentDir = env.STEP_CODING_AGENT_DIR?.trim();
  if (explicitAgentDir) {
    const agentDir = resolve(explicitAgentDir);
    const root = dirname(agentDir);
    return { root, agentDir, modelsFile: join(root, "models.json") };
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const configDir = env.STEPCODE_CONFIG_DIR?.trim() || ".stepcode";
  const root = isAbsolute(configDir) ? resolve(configDir) : resolve(home, configDir);
  return { root, agentDir: join(root, "agent"), modelsFile: join(root, "models.json") };
}
