import { readFile } from "node:fs/promises";

export const WORKFLOW_EXAMPLE = String.raw`phase("处理任务");
const worker = agent("执行者", {system:"按任务要求工作，遵守用户限制，只报告真实结果。"});
const result = await worker.ask<{summary:string}>("在这里写用户的具体任务和验收要求，返回 summary。 ");
await artifact.markdown("report", result.summary, {title:"任务结果", primary:true});
return result;`;

const source = new URL(
  "../../resources/dynamic-workflows/SKILL.md",
  import.meta.url,
);
let original;
function chapter(content, number) {
  const headings = [...content.matchAll(/^## (\d+)\. .+$/gm)];
  const index = headings.findIndex((heading) => Number(heading[1]) === number);
  if (index < 0) throw new Error(`原版工作流指南缺少章节 ${number}`);
  return content.slice(headings[index].index, headings[index + 1]?.index ?? content.length);
}

/** 编排契约唯一来源是原 ZCode 技能；适配器只说明当前底座/工具面，不删改技能正文。 */
export async function readWorkflowGuide(section = "skill") {
  if (!["skill", "reference", "patterns", "examples"].includes(section))
    throw new Error("未知工作流指南章节");
  original ??= readFile(source, "utf8");
  const content = await original;
  return {
    content:
      section === "patterns"
        ? [2, 7, 8].map((number) => chapter(content, number)).join("\n\n")
        : section === "examples"
          ? chapter(content, 7)
          : content,
    version: "step-zcode-original-1",
    // 不改原技能正文；社区元数据与运行状态以当前工具 schema / 真实返回值为准。
    integration:
      "以上编排规则来自原 ZCode 完整技能，仍用同一个编译器、引擎、调度器、journal 和 UI。子任务由 Step RPC 执行，默认沿用父会话模型，也可通过 subagent_model 指定 provider/model$reasoningLevel；具体脚本须经原确认图批准，用户可在运行卡配置模型与并发上限。EvalWorkflowSnippet 使用原版片段沙箱，AmendWorkflow 复用原版缓存，ResolveWorkflowQuestion 回答当前运行的子代理问题。工具参数以当前提供的定义为准。EvalWorkflowSnippet 接受 code/path 二选一及 timeoutMs，可选 title 仅是描述；ok:true 且 kind:completed 表示片段已成功，不要重复执行。片段返回的 git 非仓库等环境信息不等同于工具失败。不要把名册竖排或提高 max_concurrency 当作脚本并行；按原技能 §7 在 join 前发出独立 ask。",
  };
}
