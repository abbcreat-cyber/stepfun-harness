import { readFileSync } from "node:fs";

/** 与桌面服务同一凭据文件；只选择固定的官方计费通道，密钥不进入日志或协议。 */
export function readDesktopCredentialEnv(env = process.env) {
  if (!env.STEPCODE_DESKTOP_CREDENTIALS) return {};
  let data;
  try { data = JSON.parse(readFileSync(env.STEPCODE_DESKTOP_CREDENTIALS, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw new Error("桌面凭据文件不可读取"); }
  const mode = data.activeMode;
  if (mode !== "api" && mode !== "subscription") throw new Error("桌面连接类型无效");
  const key = data[mode]?.key;
  if (typeof key !== "string" || !key.trim()) throw new Error("当前连接没有密钥");
  const endpoint = mode === "subscription" ? "https://api.stepfun.com/step_plan" : "https://api.stepfun.com/v1";
  return { STEP_API_KEY: key, STEPFUN_API_KEY: key, STEP_BASE_URL: endpoint, STEP_PROVIDER_API_URL: endpoint, STEP_API_URL: endpoint };
}
