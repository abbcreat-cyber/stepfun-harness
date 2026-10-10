# 浏览器重复打开的状态保留

真实测试发现 `agent.browsers.open(url)` 命中已有标签页后仍无条件 goto，复核时清空了按钮交互结果。浏览器封装负责复用，页面状态由浏览器持有，不新增页面缓存。

- `open(url)` 命中已有 agent-owned 标签页且规范化后的完整 URL 相同：激活并返回，不重新导航。
- 路径、查询参数或片段不同：按原行为导航；不扩大标签页选择范围。
- `reuseTab: false` 仍新建标签页；显式 `tab.goto(url)` 仍允许刷新同一 URL。
- 修正源码及随包 browser-client；已安装官方插件仅迁移已知旧文件哈希，保留自定义修改。
- 验收：输入框填写、按钮点击后再次 open 同一 URL，状态保留；改变查询参数和显式 goto 仍导航；真实模型多步浏览器任务成功。
- 真实表单复测发现 `locator.inputValue()` 缺失；新增该便捷方法，复用现有 locator.evaluate 通道读取 input/textarea/select 的实时 value，支持 label 对应控件，不增加 Host 协议命令。
