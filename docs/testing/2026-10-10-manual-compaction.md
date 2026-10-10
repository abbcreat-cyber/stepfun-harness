# 手动压缩真实验收

从基线 532b75c 检查发现：前端已有 compact 命令和时间线，适配层却固定声明 compactNotWired。已发送消息编辑、回复重试和文件回退也缺少对应处理器；这些不能计为通过。本轮实现范围是手动压缩。

## 接通内容

- `/compact` 通过现有 InputLedger 准入与 FIFO 排队，执行原生 compact RPC，不发送一条普通聊天冒充压缩。
- controlOnly 轮和 compact marker 显示运行、成功、无需压缩、失败、取消；原始消息历史保留。
- RPC 总结在输入锁之外等待，期间可以停止及追加消息；立即追加也排队，避免抢进总结请求。
- 重复压缩去重，重启结算未完成标记，退出软件时不继续消费队列。
- 映射供应商选项在原生手动压缩事件中激活和清理。首次 Step Plan 实测暴露“Mapped provider options were not prepared for this prompt”，修正后通过；自动压缩沿用原聊天参数。
- 超时先停止原生客户端再释放槽位；停止请求失败不伪报取消；状态发布失败不会留下永久运行槽。

## 真实订阅验收

使用本机 v1.0.5、独立 QA 数据、Step Plan 订阅，全程后台控制，没有鼠标／宿主键盘操作。

| 场景 | 证据 |
| --- | --- |
| 已有真实历史压缩 | `step-session_8eac9356-7896-4ebe-818e-189a674ff9ff`：原生回执 tokensBefore=107024、estimatedTokensAfter=21548；原生会话文件实际新增 compaction 条目；随后仍正确回复第三轮口令“红杉8042” |
| 忙时排队压缩 | 同会话中，10 秒命令结束后执行 compact，再执行后续消息；三个 turn 的结束／开始时间严格有序；第二次回执 51051 → 21762（后者为估算），最后回复 QUEUE_AFTER_COMPACT，队列为空 |
| 停止并继续 | 同会话点击停止后约 280ms，marker=cancelled、turn=completedInterrupted；随后正常回复 STOP_COMPACT_RECOVERED |
| 短会话 | `step-session_1f568854-7708-47e4-ae04-685f72bcace8`：底座返回 Nothing to compact，界面呈现 noop 并退出运行状态 |

原生 CLI + 本机 HTTP 夹具另验证：摘要确实持久化、映射参数到达总结请求、abort 真正结束 isCompacting；不使用外部模型额度。相关整组回归 104 项通过，随后新增的启动发布失败回归也通过。类型检查、架构检查通过；lint 为 0 error、77 warning。

不修改 Step 底座可执行文件。未推送、未发布。

正式本机软件已后台重启，主输入框加载正常；8 个修改的运行文件与源码哈希一致。
