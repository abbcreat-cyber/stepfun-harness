# 随包文档工具的真实能力

实测简单中文 PDF 任务时，旧版内置说明让模型选择 HTML、FODT → PDF，精简引擎连续拒绝。能力说明必须来自实际引擎，不能把命令别名等同于完整版 LibreOffice。

- Office CLI 的 `--help` 和 `--capabilities` 从库的 `CONVERSION_FORMATS` 生成输入输出对；额外保留本项目已有 CSV 导入路径。
- 新建简单 PDF 使用随包 Python / ReportLab；已有 Office 文件按能力表转换。HTML/FODT 不伪装成已支持格式。
- 四个内置文档技能共用正确的 Windows 环境说明；保留原技能的质检要求。
- 安装升级时，只迁移官方文档技能中的旧版环境说明段；保留用户改写、其余技能正文、设置与启用状态。
- 验收包含真实订阅 PDF 生成、中文文本/页数读取，XLSX 公式及缓存核对，命令帮助内容与迁移幂等性。
