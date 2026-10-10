# 草稿预热重复启动优化验收

## 结论

修复前端就绪校验的激活边界，不修改 Step Code 底座、模型档位、权限、配置准入或会话路由。4 个新任务的对照中，原生底座启动次数从 8 次降至 4 次；消除了短暂预热后回收重建。底座自身冷启动仍约 1.9 秒，不能宣传为新任务全部秒发。

## 原因与修复

正式会话期间 readiness 为 ready。返回草稿时 key 未变，第一次 render 继承 ready，先启动预热；effect 再写 checking，导致 owner 无订阅并 retire。检查成功重新 acquire 时，旧创建尚未完成，只能等待它结束、删除，再创建。

候选进程的只记录时间插桩，以及 React owner 的只读诊断确认：同一工作区、同一 invalidationVersion，acquire 后约 13ms retire，再次 acquire，约 2.5 秒后第二次 startCurrent。新实现为每次启用/工作区或 provider/service 切换建立激活身份；不属于本次的 ready 不允许启动。迟到的发送前复查也不能覆盖新激活状态。

## Step Plan 真实任务

同一 QA profile、订阅 endpoint、step-5-preview 与原思考配置。每次仅要求返回校验码，不使用其他 API 账户。输入稳定后才计点击时间；完成时间含模型与网络，不能归入本地优化。

| 场景 | 修复前用户行上屏 | 修复后用户行上屏 |
| --- | --- | --- |
| 新建后立即发送 A | 2972ms | 2265ms |
| 新建后立即发送 B | 2615ms | 2195ms |
| 等预热 5 秒后发送 A | 121ms | 119ms |
| 等预热 5 秒后发送 B | 128ms | 126ms |

立即发送的驱动在后测增加了输入水合稳定回读（约多 150ms，位于点击计时前），因此不把表中冷态差值全部归因于产品优化。可重复确认的收益为取消重复启动：前测 8 次启动/4 次提前回收，后测 4 次启动/0 次提前回收（均不计测试结束时退出）。等待输入期间有效底座首次就绪，两个样本从新建后约 5.0/5.4 秒降至约 2.5 秒。

修复后会话：

- `step-session_b27e0ecd-0f1b-425a-a657-8292fd48c9b5`
- `step-session_30442653-f17c-430c-b69a-0c47fb2cd1dd`
- `step-session_3a153dba-a81e-4e99-913a-e17b6b80575a`
- `step-session_8b248fed-5dfa-4834-8a25-38750e47c3f4`

清除候选插桩后额外回归：

- `step-session_34bf761d-0415-4af0-8030-b06ef9a24203`：同会话 4 轮回复通过，3 次续发上屏为 81/76/81ms。
- `step-session_460a9c2e-b7c6-42a4-8961-8c4aeb927827`：粘贴图片成功上传并识别校验码。

过程中一次驱动因编辑器初始水合清空提前注入的文字而超时，未计入性能样本。修正驱动为回读输入稳定后再点击；没有调整产品发送逻辑来绕过该次超时。

## 自动验证与本机交付

- `node --test packages/ui/test/draftReadinessActivation.test.mjs`：真实 React + headless Chrome 验证；修复前首次 render 错误放行可复现，修复后通过。覆盖工作区/service/provider 切换、旧回包、事件优先、无模型、读取失败及发送前复查。
- `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/draftPrewarmWait.test.ts`：2 项通过，复用在途创建、未知投递保留及旧代隔离保持。
- `pnpm typecheck`、`pnpm architecture:check --changed` 通过。
- `pnpm lint`：77 个既有 warning，0 error。
- production desktop build 成功；候选真实任务测试后以同一 app.asar 替换正式本机，备份旧包，后台正常退出/重启，保留原隐藏状态。
- 正式 app.asar SHA-256：`ce591b3c1c6cfb6e55beee8606a546ec3ae841a49ffcc7e165bc3a8a017df53b`。
- 正式 adapter 未加入插桩；候选 rpc-client 已还原。仅本地 Git，不 push、不发布 Release。

原始计时证据保存在本机 QA 目录 `live-audit-20261010` 的 `prewarm-rpc.jsonl`、`extended-profile/prewarm-probe-*.json` 和带时间戳的结果文件，不提交个人 profile 或原始会话。
