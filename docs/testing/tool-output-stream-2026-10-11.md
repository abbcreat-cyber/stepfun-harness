# 工具输出增量验收

- 原有问题：每次原生累计输出更新都克隆并发送整行；重复内容也重复传输，长输出更新量随累计前缀增长。
- 现在首段及结构变化用完整行；稳定运行中的新增后缀用既有 output.text delta，相同输出不发送更新；最终结果、失败/取消与日志元数据完整收口。
- 100 次每次增长 1024 字符的固定测试：旧完整行更新 5,202,400 bytes，新增量更新 108,949 bytes，减少 97.91%。仅比较该组运行中更新，不包括终态帧，也不是整体应用加速比。
- 20 项回归通过：中文/Emoji、重复事件、重复参数、尾窗替换、清空、参数与状态变化、并行工具归属、突然中断、两类 delivery profile 终态一致、中途快照续接、错误/取消与完整日志预览。包含真实 Step 可执行文件的长输出验收（本地响应夹具）。
- Step Plan `step-5-preview` 实际运行 PowerShell：间隔输出 30 行中文。UI 在任务尚未结束时显示第 1 行，终态 30 行各出现一次，展开历史可见最终内容。成功验收约 19 秒。
- 首次 UI 验收脚本因卡片完成后自动收起而持有失效 locator；改为在 DOM 中原子查询当前卡片后重测通过，未借此修改产品状态。
- typecheck 通过；lint 0 errors / 77 原有 warnings；架构检查 0 violations。
- 本机证据位于 `D:/Projects/stepcode-publish-work/output-stream-20261011/profile/` 的 results.json、带时间戳结果和 output-while-running.png、live-cumulative-output.png。
- 仅更新本机和本地 Git。真实 UI 为 Windows 中文暗色桌面；可恢复通道以共享协议 reducer/profile 验证终态收敛，未做手机实机验收。
