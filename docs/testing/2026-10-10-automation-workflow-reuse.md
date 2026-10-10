# 自动化管理与保存工作流复用验收

基线 v1.0.6 / 710e598。使用独立 QA profile、本机正式程序和 Step Plan 订阅，通过后台 DOM/RPC 操作，没有操纵宿主鼠标键盘。本轮按用户要求不测试用户名或语言切换，不推送、不发布。

## 自动化生命周期

`step-session_db429a4f-998f-4db6-a587-d9bd6c83de5c`：模型调用 cron_create 创建每周一 09:00 的测试任务，cron_list 确认存在。自动化界面显示一致的时间与下一次执行时间；暂停后重载仍显示已暂停；删除并重载后不再出现。测试任务已删除，没有遗留定时执行。

首次驱动使用 DOM click 打开 Radix 菜单，没有触发其 pointerdown 入口。校正为仅向目标 DOM 派发事件后复用原任务完成验收，没有额外创建任务，不计为产品故障。

## 保存工作流复用故障与修复

原会话 `step-session_1428f8e2-c864-4e11-b7d4-b506a2143e30` 使用已配置订阅模型，创建单个“计算员”子代理，计算 19+23；首次运行 `step-workflow-052377d6-2f34-417b-9172-88a86d5b46c3` 返回 42，SaveWorkflow 和 ListSavedWorkflows 成功。

重载后，从全局模板卡片点击运行，创建的会话 `step-session_63e0caf7-3fe3-4298-ad4d-dfc73a7dcea0` 却使用固定默认 `step/step-5-preview`。原生 journal 中 status=failed，错误为 `Failed to create the subagent session: Model not found: step/step-5-preview`。

修复：启动器读取目标工作区最近已接受模型或目标 Host 首选模型，复用 ModelSelectionService 和普通提交校验，显式携带 providerId/modelId/reasoningLevel。全局和项目入口共用；缺少有效模型时不创建会话。适配层在创建运行卡前再次落定模型，并与普通输入共享串行准入。

使用同一个已保存模板复测：

- 新会话：`step-session_d656c264-db21-4ec5-9a70-c9930a117dc0`。
- 新运行：`step-workflow_mv1wzjhm_5708_5`，与首次运行 ID 不同。
- 主会话与原生 actor 记录均为 QA 配置的 `new-provider / step-5-preview`，reasoningLevel=enabled。
- SQLite journal 的 status=completed，独立读取 result_json 得到 result=42。
- 重载后卡片显示 completed，再从界面删除该测试模板，列表确认消失。

## 检查与交付

- 4 项模型解析回归通过：目标默认、最近已接受配置、删除/不可用拒绝、无效档位和读取失败。
- 13 项工作流模型选择与能力回归通过。
- typecheck、架构检查与 renderer 生产构建通过；lint 77 warning、0 error。
- 本机安装目录更新 renderer 和桥接文件，后台重启并以 showInactive 恢复原可见窗口，不抢焦点。
- 原始脚本、结果与截图位于本机 `D:/Projects/stepcode-publish-work/live-audit-20261010/`，未提交 QA 配置或凭据。
