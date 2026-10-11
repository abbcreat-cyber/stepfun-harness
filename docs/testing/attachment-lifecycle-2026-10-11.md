# 附件生命周期验收

## 复现与修复

旧实现的重复 prepare 会把修改后的文档副本覆盖回原始附件；8 路并发 prepare 在 Windows 复现 EPERM rename。历史同步还会重新读图并编码，或重写已经删除的文档副本。

现在创建副本使用排他复制并合并同一路径在途请求，已有副本不改写。历史编辑/重试与分叉动作匹配显式走只读准备，已上传文档使用元数据生成提示。

## 验证

- 27 项自动化测试通过：附件上传、空文件、范围预览、校验失败、重启保留副本、重复/并发准备、目录冲突重试、历史只读同步、消息编辑及分叉、检查点撤销。包括真实 Step 可执行文件配合本地响应夹具的分叉回归。
- 2 项 Step Plan `step-5-preview` 小任务通过：文档上传并执行 read_file → edit_file → read_file（约 27 秒）；粘贴图片识别 `STAR 4268`（约 5 秒）。未使用其他 API 账户。
- 第三项 UI 验收不调用模型：切回文档会话，修改仍保留；通过撤销确认界面恢复原始字节。用户原始上传文件始终未修改。
- typecheck 通过；lint 0 errors / 77 原有 warnings；架构检查 0 violations。
- 本机证据：`D:/Projects/stepcode-publish-work/attachments-20261011/profile/results.json`、edited.json 及截图。测试数据和凭据未入库。

本轮只更新本机与本地 Git，不发布云端。真实 UI 验收范围为 Windows 中文暗色界面与 Step Plan；不将减少读写次数描述为未经测量的固定响应时间提升。
