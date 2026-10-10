# 桌面手动压缩对接

前端有 `/compact` 和压缩时间线，但适配层声明 compactNotWired；底座 RPC 已提供 compact、compaction_start/end 与 abort。

输入经过现有 InputLedger FIFO。压缩不伪装为普通聊天、不另建模型会话，使用当前已选模型与原生 compact API；原生会话树负责摘要及保留边界，桌面历史不删除。

`compact 命令 → 台账准入 → 等待前一任务结束 → 原生 compact → controlOnly 轮与 timelineMarker 终态 → 后续队列`

- ACK 在准入后返回，不能让主输入操作锁等待模型总结。
- 忙碌或暂停时加入现有队列；重复压缩命令不创建多份同时执行的维护任务。
- 只有底座真实成功才展示成功；会话太短展示 noop；失败、停止、重启均需退出 running。
- 压缩期间后续消息排队；停止使用原生 abort 并等待 compact 请求真正结束，不能用固定延时假装完成。
- 后续模型续发必须看到原生摘要；页面展示原消息，压缩 marker 与计数来自实际回执。
- 映射供应商参数在 session_before_compact(reason=manual) 激活，在 session_compact/failed 清理；自动压缩保留原聊天轮次的参数。维护期间的立即追加也进入队列，不向 native steer 误投递。
- 验收：原生成功/取消、前端空闲及排队、重复请求、停止、失败恢复、短上下文，以及真实订阅压缩后继续回答。
