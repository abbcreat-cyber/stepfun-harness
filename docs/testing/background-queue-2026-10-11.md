# 后台队列与停止状态验收

## 结果

- 无订阅的队列编辑、删除、排序现在先保存再判断是否推送。真实桥进程取消订阅后操作，磁盘只保留修改后的有效排队项。
- 1000 轮完成、失败、取消共 3000 次准入后，终态调度记录清空；活跃 pending、submitted 和 queued 保留。聊天正文和命令 ACK 去重不受影响。
- 原生 shell 主动停止的精确回执 `Command aborted` 映射为 cancelled；前端按现有 stopped 样式展示。实际权限/执行错误仍显示错误。

## 验证

- 分组运行共 68 个不同自动化用例通过：输入准入、队列恢复、无订阅保存、磁盘忙失败、超时不重发、晚 ACK 不复活、流式投影、自动任务来源、当前/冷会话快照。
- Step Plan `step-5-preview` 真实链路约 35 秒：PowerShell 等待中加入两条消息，删除一条后停止；切出并重新打开会话，继续剩余项。删除项未送出，保留项只运行一次；超过原定等待时间后，停止命令的结束标记仍不存在。
- 额外真实停止任务确认原生 PowerShell 行为 cancelled 且无 error 对象。重新打开该历史只做 UI 检查，灰色停止状态及 `Command aborted` 原始输出可见，没有再次调用模型。
- 首轮脚本曾把“队列暂停”误当成“底座停止完成”，改为等待真实终态后通过；停止卡片的 UI 文案沿用“已停止”，修正了脚本对“已取消”文字的错误期待。
- typecheck 通过；lint 0 errors / 77 原有 warnings；架构检查 0 violations。
- 证据：本机 `D:/Projects/stepcode-publish-work/queue-background-20261011/profile/` 的带时间戳 results 文件及截图；`D:/Projects/stepcode-publish-work/queue-background-tests-20261011.log`。不提交模型凭据或测试会话。

只更新本机与本地 Git。真实 UI 验收为 Windows 中文暗色界面；手机链路通过 replayable 恢复协议回归，未做手机设备实测。台账回收证明减少旧记录扫描，不承诺未经计时验证的固定加速比例。
