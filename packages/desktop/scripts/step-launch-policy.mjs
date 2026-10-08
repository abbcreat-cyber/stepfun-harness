import { isAbsolute, join } from "node:path";

/** 凭据缺失只影响模型发送，不影响打开窗口与配置入口。 */
export function stepLaunchCredentials(base) {
  const env = { ...base };
  const key = env.STEP_API_KEY?.trim() || env.STEPFUN_API_KEY?.trim();
  if (key) { env.STEP_API_KEY = key; env.STEPFUN_API_KEY = key; }
  else { delete env.STEP_API_KEY; delete env.STEPFUN_API_KEY; }
  return env;
}

/** 验收/独立用户配置不共享账户、会话与 Electron 单实例锁。 */
export function stepLaunchProfile(profile) {
  if (!profile) return {};
  if (!isAbsolute(profile)) throw new Error("Step Code profile directory must be absolute");
  return {
    STEPCODE_SETTINGS_DIR: join(profile, "settings"),
    STEPCODE_DEFAULT_PROJECT_DIR: join(profile, "workspace"),
    STEPCODE_CONVERSATION_DIR: join(profile, "conversations"),
    STEPCODE_STORAGE_ROOT_DIR: join(profile, "state"),
    STEPCODE_DESKTOP_CREDENTIALS: join(profile, "state", "desktop-credentials.json"),
    STEP_CODING_AGENT_DIR: join(profile, "step-config", "agent"),
    ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "electron"),
    ZCODE_DESKTOP_HOME_DIR: join(profile, "home"),
  };
}
