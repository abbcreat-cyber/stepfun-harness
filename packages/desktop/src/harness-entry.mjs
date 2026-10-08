import { app, dialog } from "electron";
import { join } from "node:path";
import { packagedEnvironment } from "./harness-environment.mjs";

try {
  if (app.isPackaged) {
    const home = process.env.HARNESS_HOME || join(app.getPath("appData"), "StepFun Harness");
    const env = await packagedEnvironment(process.resourcesPath, home);
    // 静态导入 main 会使共享 chunk 提前捕获旧环境，必须初始化后动态加载。
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
  await import("./index.js");
} catch (error) {
  dialog.showErrorBox("StepFun Harness 启动失败", `安装文件缺失或配置无效，请重新安装。\n${error.message}`);
  app.exit(1);
}
