// 单次隔离 TS loader；只处理测试传来的假 Registry / 公共 schema，不驻留业务状态。
import { ModelConfig } from "../../provider/src/index.ts";
import {
  buildCliSyncProviders,
  syncCustomProvidersToStepCliModelsFile,
} from "../../services/src/model-provider/cliProviderSync.ts";
import { zcodeProtocolMethods, zcodeProtocolSessionMethodContracts } from "@zcode/shared";
import { readFile } from "node:fs/promises";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (input.action === "contract") {
    const contract =
      zcodeProtocolSessionMethodContracts[zcodeProtocolMethods.interactionPrepareModelExecution];
    const params = contract.params.parse(input.params);
    process.stdout.write(
      JSON.stringify({
        ok: true,
        value: { params, ...(input.result ? { result: contract.result.parse(input.result) } : {}) },
      }),
    );
  } else {
    const views = input.views.map((view) => ({
      ...view,
      models: view.models.map((model) => ({
        ...model,
        config: ModelConfig.fromData(model.config).toJSON(),
      })),
    }));
    const plan = buildCliSyncProviders(
      views.map((view) => view.providerId),
      views,
    );
    if (plan.skipped.length)
      throw new Error(`Production projection skipped ${JSON.stringify(plan.skipped)}`);
    const result = await syncCustomProvidersToStepCliModelsFile(input.env, plan.providers);
    const document = JSON.parse(await readFile(result.modelsFilePath, "utf8"));
    process.stdout.write(JSON.stringify({ ok: true, value: { views, result, document } }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
