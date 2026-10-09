# 会话模型选择恢复与定时续跑

- 唯一执行选择为 bridge primarySession.modelSelection；UI 草稿保存下一次提交意图。
- conversation snapshot 的 config 必须携带完整 modelSelection（含 options），不能只发
  provider/model 两个旧版展示字段。无已保存选择时不虚构默认选择。
- 已有会话中因旧快照缺字段而持久化为空的模型草稿，只从该会话的完整选择补齐；
  保留正文、权限和非空的用户选择，不用工作区默认模型替换，也不替换下线模型。
- UI 的 enabled/disabled 等选项与 SDK 的 off/high 档位属于两个空间。
  session/resume / setThoughtLevel 与普通发送共用 runWithPreparedClient 的映射判断，
  有显式供应商 map 时保存原始选项；没有映射时仍严格校验底座实际能力。

```text
会话存储 → primarySession → config.modelSelection → session composer draft → submission
定时任务 → session/resume → 同一模型准备入口 → 原生档位或供应商 map → prompt
```

验收覆盖：冷恢复、新旧空模型草稿、用户已有选择不覆盖、mapped/native 档位、
无效档位与忙碌拒绝，以及真实订阅定时创建→重开→触发一次→终态与计数。
