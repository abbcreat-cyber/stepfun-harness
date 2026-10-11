# 原生搜索结果完整性

真实 Step 工具返回正文及 details：search_files 的 matches/truncated/timedOut/matchLimitReached，list_directory 的 returnedEntries/truncated。底座拥有搜索与限额；适配层只透传可验证的结果事实；前端不通过“返回条数等于请求上限”猜测截断。

适配层把经过类型检查的状态投影到 output.display(kind=search_result)。截断与超时不复用 output.truncated（后者是桌面按需读取引用），不伪造完整结果总数。tool_result 扩展对确已截断/超时的成功结果补充简短模型可读说明，保留原正文和 details，不重跑搜索、不自行提高限额。

前端搜索卡支持展开原始结果、滚动、复制。条目归类及目录摘要识别原生 snake_case 工具名；等待/审批/运行/停止复用既有阶段解析。中英文提示区分部分结果、超时和明确的零匹配。历史缺少展示元数据时仍能展开正文，但不猜测完整性。

新 display 为可降级展示字段；旧客户端未知类型退回原始文本，不改变执行协议。通过 V4 现有行投影服务于桌面连续流及历史/远程快照，保持同一事实源。

验收覆盖正文保留、受限/超时/零匹配、未知工具及异常 metadata；用真实订阅执行目录列举、受限搜索与零匹配，再验证界面展开和复制。本次仅本地部署与提交。
