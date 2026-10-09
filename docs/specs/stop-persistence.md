# 停止命令与快照保存

状态所有者仍是 session worker 的 InputLedger 与 Step client；不新增可执行队列。
本改动位于 packages/stepcode-adapter（现有 architecture-policy 未登记该 legacy 包）。

```text
v4 stop / session stop → 冻结 InputLedger → 订阅 idle → 发出 abort → 等待 idle
                                           └→ 实时快照 → 尝试保存 → 有限重试
desktop continuous / mobile replayable ← 同一内存状态、现有 seq/revision
```

- 停止不得以文件保存成功为前提；abort 失败或 idle 超时仍向调用方报告失败。
- v4/legacy 共用唯一停止入口；待处理工作流取消的 changed/摘要保存回调在发出
  abort 后执行，回调失败记录诊断，不阻断底座中断。
- Windows EPERM/EACCES/EBUSY 等快照 IO 错误不得阻止实时帧或终态投影。
- 短暂占用以 25/50/100/200/400 ms 的异步定时有限重试；不阻塞事件循环。
- 重试序列只属于原 session；重试时读取当前状态，不重放旧快照、不复活队列。
- 保存成功清理重试；持续失败记录错误，保留原原子文件，不伪称已落盘。
- 仅快照投影使用上述策略；输入准入等显式事务写入仍保留原错误语义。
- 用户停止标记优先于取消期间工具错误的投影；只有收到真正的 settled 才给回合终态。
- 验收：注入瞬时及持续 rename 故障，核实 abort、终态帧、队列冻结、恢复保存；
  无故障时的停止、追加与恢复不回归；本地已安装 runtime 用 Step Plan 小任务验证。
