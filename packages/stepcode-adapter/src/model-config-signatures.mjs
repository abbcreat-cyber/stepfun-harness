import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

let pathsContract;
/** plain Node 桥与 TS 服务共用公共路径契约，沿既有 shared/node 加载方式注册 TS。 */
export async function resolveStepRuntimePaths(env = process.env) {
  pathsContract ??= (async () => {
    const { register } = await import("tsx/esm/api");
    register();
    return import("@zcode/shared/node");
  })();
  return (await pathsContract).resolveStepConfigPaths(env);
}

function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** SDK 可从环境读取凭据/endpoint；摘要只在内存使用，不能写日志或错误。 */
export function modelEnvironmentSignature(env = process.env) {
  const credential = /(?:API_KEY|TOKEN|SECRET_ACCESS_KEY|ACCESS_KEY_ID|APPLICATION_CREDENTIALS|BASE_URL|API_URL)$|^(?:AWS_PROFILE|AWS_REGION|AWS_DEFAULT_REGION|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|STEP_CODING_AGENT_DIR|STEPCODE_CONFIG_DIR)$/i;
  return digest(Object.fromEntries(Object.keys(env).sort().filter(key => credential.test(key)).map(key => [key, env[key]])));
}

/** 与 Step 启动器同一配置根；签名只在进程内比较，不输出凭据或签名。 */
export async function readModelConfigSignatures(filePath, env = process.env) {
  let document;
  try { document = JSON.parse((await readFile(filePath || (await resolveStepRuntimePaths(env)).modelsFile, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return new Map(); throw new Error("底座模型配置不可读取"); }
  const signatures = new Map();
  for (const [provider, entry] of Object.entries(document.providers ?? {})) {
    for (const model of entry.models ?? []) {
      // 供应商兼容/认证参数也属于启动快照，不能只枚举旧的四个字段。
      const { models: _models, ...configuration } = entry;
      const serialized = JSON.stringify({ configuration, model });
      const referencedEnv = Object.fromEntries(Object.keys(env).sort().filter(key => serialized.includes(key)).map(key => [key, env[key]]));
      signatures.set(`${provider}\0${model.id}`, digest({ configuration, model, referencedEnv }));
    }
  }
  return signatures;
}
