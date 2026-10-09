// 上游公共入口部分指向 TS 源码；只在首次使用工作流时注册仓库已有的 TS loader。
import { register } from "tsx/esm/api";
register();
export const engine = await import("@zcode/dynamic-workflow");
export const { runWorkflowScript } = await import("@zcode/dynamic-workflow-runtime");
export const { createSqliteSessionStore } = await import("@zcode/adapters/storage");
export const { boundCausalityGraph } = await import("@zcode/core/create-workflow-graph-bounds");
export const { reduceWorkflowRunsState } =
  await import("@zcode/shared/workflow-runtime-projection");
export const { createNodeFileSystemAdapter } = await import("@zcode/adapters/fs");
export const { createNodeExecutionAdapter } = await import("@zcode/adapters/exec");
export const { NodeToolArtifactStore } = await import("@zcode/adapters/storage");
export const {
  createDynamicWorkflowSnippetService,
  buildImportedCache,
  preflightAmendImport,
  executeWorldRead,
  executeArtifactPublish,
  artifactsOf,
  listArtifactItemsFrom,
  readWorkflowArtifactBytes,
  listWorkspaceNodesFrom,
  readWorkspaceNodeResultFrom,
} = await import("@zcode/bootstrap/workflow-io");
export const savedWorkflows = await import("@zcode/core/saved-workflows");
export const { parseModelPickerValue, formatModelPickerValue } = await import("@zcode/shared/model-selection");
