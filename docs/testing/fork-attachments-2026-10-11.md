# 分叉附件隔离验收

- 旧实现复现：已编辑工作副本分叉后变回 original；已删除工作副本被重新生成。
- 修复后：复制分叉时的当前工作副本，原始上传独立保留；原生与前端的私有附件路径使用同一映射；删除状态保留。
- 17 项回归通过，覆盖原生新旧回复分叉、取消及失败恢复、编辑重试、附件重复准备、父子文件隔离、JSON 嵌套路径、前后缀边界、Windows 大小写与分隔符。原生分叉回归使用真实 Step 可执行文件配合本地响应夹具。
- Step Plan `step-5-preview` 真实 UI 验收约 34 秒：上传文本，父会话改成 `status=parent`；点击分叉，新会话继续将同一附件改成 `status=child`。确认子路径不同、子内容为 child、父内容仍为 parent、上传源文件仍为 original，父会话未增加子输入。
- typecheck 通过；lint 0 errors / 77 原有 warnings；架构检查 0 violations。
- 本机证据：`D:/Projects/stepcode-publish-work/fork-files-20261011/profile/` 下 results.json、proof.json、fork-current-document.png。凭据和测试会话未入库。
- 本轮只更新本机与本地 Git。此规则用于新创建的分叉，不改写已有父/子历史；共享项目工作区仍共享，私有附件副本相互独立。历史回复分叉复制当前附件状态，不是工作区时间快照。
