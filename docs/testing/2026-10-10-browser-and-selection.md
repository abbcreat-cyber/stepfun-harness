# 浏览器交互与选区引用验收

基线 `7a32768`。本机正式程序、隔离 QA profile、Step Plan 订阅。使用后台 Inspector/CDP/DOM 与本地临时 HTTP 测试页，不操作宿主鼠标、不使用虚拟机。

## 五项结果

全部通过，原始结果与截图保存在本机 QA 目录，结果文件为 `results-1791618909951.json`。

| 场景 | 证据 |
| --- | --- |
| Markdown 只提交选中段落 | `step-session_3ee2735f-e153-4894-bc3f-eec494b510fb`：文档含两个不同标记，只选第二段添加到任务；实际 userInput 包含 SELECTED_84726，不含第一段 UNSELECTED_19285，模型不调用工具即可正确复述编号与 36 元预算 |
| 移除选区后不再提交 | `step-session_c5d1e091-bbc3-4f67-95f3-ba0cd7ac16dc`：添加引用再移除，实际已接受输入没有 REMOVED_REFERENCE_58241，普通消息正常回答 |
| 下拉框、复选框、多行文本 | `step-session_d9845cb2-4cbe-48b0-bf3a-0c3dc4e35a0b`：浏览器插件操作真实本地网页；服务端只收到一次提交，字段严格等于 blue、true 和“周五交付\n备注_58271”；模型读到页面确认码 SAVED_FORM_93628 |
| iframe 内容读取 | `step-session_bbd5e3ea-b01e-4fc5-85d0-2f5ac8e423f9`：嵌入页面实际被请求，模型通过浏览器读到未在提示中透露的随机验收码 FRAME_734697 与 57.50 元金额 |
| 导航失败后继续正常访问 | `step-session_e678b7a1-10bb-4596-80cd-73bf14a06b21`：先访问端口 1；Electron 日志确认 ERR_UNSAFE_PORT。随后同一标签页成功访问正常本地地址，服务端收到请求，模型读到 RECOVERED_BROWSER_46371 |

## 观察与边界

- 浏览器表单、iframe、失败恢复分别约 88、65、114 秒，包含模型推理和多次工具交互，不能将其等同于单次导航耗时。
- 最后一项模型曾把返回表达式写在 try/catch 内部，导致 Node REPL 没有输出；它随后只读检查状态并继续成功。模型最终把错误解释成连接拒绝，但原生日志显示真正原因是 ERR_UNSAFE_PORT；不将模型的解释当成产品诊断依据。导航处理本身保留失败返回，未改动适配代码。
- 本轮没有确认新的产品缺陷。类型检查通过，Lint 为原有 77 warnings / 0 errors。
- QA 服务与实例正常退出，正式软件保持原状态；只提交本地 Git，不推送、不发布。
