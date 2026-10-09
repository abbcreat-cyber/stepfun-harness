# 工作流片段参数兼容与结果展示

## 证据

2026-10-09，会话 step-session_0d86ab93-545b-4fab-8792-c2c2401da684 首次 EvalWorkflowSnippet 多传 title，被 SDK additionalProperties:false 拒绝；去掉 title 后同一片段返回 ok:true / completed。随后模型继续构思，原会话以 Request was aborted 结束，未调用 CreateWorkflow。不能把第二次成功说成工具卡死，也不能隐藏第一次真实失败。

## 行为与边界

- 社区适配层将 title 声明为可选、最多 160 字符的说明元数据。只兼容此已知字段；不关闭严格参数校验、不猜改代码、不放行其他未知字段。
- code/path 二选一、timeout、沙箱与原权限规则保持原入口。title 全链路保留到工具输入/权限详情，不能进入脚本执行或改变其权限。
- 片段返回保留原 artifact/kind/status 等字段，增加统一 diagnostics/logs/response/durationMs；通过既有 eval_workflow_snippet display 协议交给现成前端卡片。成功卡显示已执行、耗时与可展开返回值；失败保留诊断。
- display 只投影真实结果，不根据标题、模型正文或停止后的历史补造成功。停止/拒绝/编译错误不得被标为成功。
- 原版工作流技能正文保留，适配说明明确元数据与最小冒烟流程，避免简单连通性测试变成无关环境检查。

```text
模型参数 → 声明校验 → 工作流唯一 owner / admission → 原沙箱与授权
          → 真实结果 + 耗时 → 有界 display 投影 → 原前端结果卡
```

## 验收

参数兼容、未知字段拒绝、取消/权限/诊断、display schema 与边界截断回归；使用 Step Plan 验证携带 title 的片段和可确认的最小工作流真实完成。保留原会话记录，安装本地候选并重启。
