# 长历史分支与编辑重试

沿前端编辑/重试入口、adapter 历史控制和 Step Code 原生 fork 链路检查。本轮重复工作和超长参数问题位于 history-controls，底座 fork 与前端协议无需修改。

## 分支回溯

activeEntries 仍按 entry id 建立 Map，再从 leafId 沿 parentId 回溯，最后反转为正序。用 Set 保存已访问的 entry 对象以检测环，不再每步扫描已有 branch。保留重复 id 最后值胜出、空叶子空分支、缺父/缺叶/循环报错、旁支忽略与返回原对象语义。访问集合仅在一次调用内存在，不缓存跨轮事实。

## 编辑与重试

在已通过 guard 和原生 fork 后，逐行计算 rowHighWater 的最大值，而不是将所有 rowId 展开为函数参数。保持已有高水位、不重用消息行号、附件传递、撤销文件、模型选择、持久化与回滚顺序。200,000 行边界测试必须通过真实 historyCommand 入口，包括 editUserQuery 和 retryAssistant。

状态仍由 session worker 唯一拥有：前端 target/revision → guard → 附件与模型准备 → 原生 fork → 计算高水位/替换派生历史 → 持久化 → 现有 admitAndSend。桌面与手机的订阅、恢复及序号规则不变。

## 验收

- 长链/旁支/环/缺父及重复 id 语义；受控前后时间及输出身份比较。
- 20万行编辑和重试不抛调用栈错误，原先较高水位保留，旧行不会误删。
- Step Plan 小任务经过编辑取消、编辑提交、重试、重载及续问，检查新历史和真实模型上下文一致。
