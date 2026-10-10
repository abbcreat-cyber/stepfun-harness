# 文件撤销边界与原子保存验收

基线 `20c0057`，本机 v1.0.7 加本地 Markdown 修复。独立 QA profile、Step Plan 订阅；后台 DOM/Inspector 调用，没有操作宿主鼠标或使用虚拟机。

五项全部通过，原始结果与截图保留在本机 QA 目录，结果文件为 `results-1791621305015.json`。

| 场景 | 实际证据 |
| --- | --- |
| 带 BOM、CRLF 的文件编辑后撤销 | `step-session_90a58e78-1702-4b24-856d-df84204112e6`：edit_file 将 amount=10 改为 25，点击该轮撤销后 Buffer 与修改前完全相等，包含 UTF-8 BOM、中文、CRLF 和末尾换行 |
| 同轮串行两次写入 | `step-session_d1864a93-61b7-437e-92b9-f4bbe91e0dc3`：同一轮实际发生两次成功 write_file；最终为 FINAL_92417，撤销恢复 BASE_73195，没有只退到中间版本 |
| 新建零字节文件后撤销 | `step-session_555ce6fd-eddb-41e1-8a8d-01aaa3beb20f`：实际文件大小为 0，UI 仍提供撤销，应用后文件不存在 |
| 撤销后再次写入并再次撤销 | `step-session_5dbdec34-3700-47e2-a71e-39d00bb5325e`：首轮写入、撤销、第二轮写入、再次撤销全部成功；两次回退均恢复当前文件的原始基准 ORIGINAL_48215 |
| 原子替换后的预览刷新 | 先打开 Markdown，再写同目录临时文件并 rename 替换原路径；不重新打开标签，预览自动显示 ATOMIC_NEW_94251 |

模型任务均限制为明确文件工具，不使用 then_run 或 shell 修改，因此符合既有检查点撤销规则。原子保存测试只操作 QA 文件。

本轮没有发现新的产品缺陷，没有改动运行代码、底座或用户配置。类型检查通过；Lint 为原有 77 warnings / 0 errors。QA 实例正常退出，正式实例保持运行。仅提交本地 Git，不推送、不发布。
