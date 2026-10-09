# 新会话首发响应

## 目标与基线

2026-10-09 Windows 隐藏桌面真实 Step Plan 小任务：点击发送到权威消息可见分别 6895ms / 6358ms。createSession 约 4s，首次 conversation 订阅约 2.5s。不能等待冷启动才让首页转为会话布局。

## 状态与边界

Renderer 的首发预览仅为 pane-local pending overlay，不代表已接收，不新增队列、不发第二条命令、不提前改 sessionId。模型选择、命令幂等、失败草稿恢复、权限与执行准入仍沿用原链路。只对普通草稿首发展示；slash 命令保持原行为。

```text
点击发送 → pane 展示待确认输入 / composer 移到底部
         → 原 config barrier → Host → 唯一 session worker → 原命令确认
         → 预览关联真实 sessionId + commandId → 权威 userInput 接替预览
失败/拒绝 → 移除预览 → 原 Composer 恢复草稿
```

预览不得泄漏到其他 workspace、draft generation 或其他 session；ACK 不得清除其他提交预览。desktop continuous 与 mobile replayable 的上行和恢复语义不变。

工作流运行目录仍由 workflow service 唯一维护。普通会话的只读 runs 查询，在既无已加载 service 又无持久 workflow-runs.sqlite 时直接返回空，不加载编译器、不创建数据库。真正创建工作流仍走 service；有历史时照常恢复。

底座阶段测量进一步确认：新 CLI ready 约 1.8–1.9s，随后立即 new_session 重跑空会话初始化另耗约 1.45s。reset 已创建独立客户端后，首次仅在 get_state 确认无消息/待处理消息/streaming/compacting 且 get_messages 为空、无 resume/continue 参数时认领启动会话；之后仍调用 new_session。不修改 Step 底座，不跳过工具注册或模型准入。草稿首发等待当前 single-flight 预热的真实完成结果，避免同时另建第二套 SDK；被回收或换代的预热不可复用。

## 验收

- 新会话点击后 500ms 内可见 pending 消息与底部输入框，首页问候消失；权威消息到达后只保留一份。
- 原会话续发、slash、附件、拒绝/断连草稿恢复不改变；跨会话不显示旧预览。
- 工作流空列表不创建数据库；有运行记录和活跃 service 时仍能读出真实列表。
- Step Plan 有界真实小任务、UI 截图、定向回归、typecheck/lint/architecture；更新本地包并重启。
