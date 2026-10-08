# 接入自定义模型

在模型设置中选择“添加供应商 → 创建自定义供应商”。填写服务地址、鉴权方式和服务实际提供的模型 ID；协议默认是 OpenAI Chat Completions，也可选择 OpenAI Responses 或 Anthropic Messages。供应商名称只是显示名，模型 ID 是服务的路由标识，都不决定核心代码分支。

服务必须兼容所选协议。没有模型目录接口的服务也可以手动填写模型 ID，不需要增加厂商代码。私有协议需要独立适配，不属于这三种标准协议的兼容范围。

## 连接设置

- **API Key（协议默认）**：填服务的 API Key，按所选协议发送默认鉴权。
- **仅自定义 Headers**：在高级配置中填服务要求的请求头，不再额外发送默认 Bearer 或 x-api-key。
- **无默认鉴权**：适合不要求 Key 的本地或自建服务，不需要填一个假的 Key。

请求头使用 JSON 对象，例如：

```json
{
  "x-api-key": "YOUR_SERVICE_KEY",
  "X-Client": "StepCode"
}
```

服务若采用非标准请求参数，可以配置对应协议的兼容字段。一个不接受 store、流式 usage 或 max_completion_tokens 的 Chat Completions 服务可使用：

```json
{
  "supportsStore": false,
  "supportsUsageInStreaming": false,
  "maxTokensField": "max_tokens"
}
```

兼容字段会按所选协议校验，不适用字段会报错。字段是否被消费仍取决于 Step 运行时版本；当前版本没有逐项验证所有兼容开关，新增或调整参数需要真实 HTTP 回归。不要把其他服务的设置照搬过来；先用协议默认值，只有服务文档或明确错误说明需要时再调整。

## 模型设置

上下文窗口、最大输出 Token、图片输入和工具调用按服务实际能力设置。手动关闭的图片或工具能力会保留。高级模型配置可以提供模型专属 Headers、compat、thinkingLevelMap、samplingParams 和 reasoning。

例如固定一个附加采样参数：

```json
{
  "samplingParams": {
    "temperature": 0.2
  }
}
```

这些参数仍由原生 SDK 发出。不能用附加参数替换模型 ID、对话内容、stream 等协议身份字段。现有参数映射沿受限 CEL 执行；配置错误会在发请求或工具执行之前报错。

清空高级输入可恢复继承，整个配置值设为 null 可明确清除继承项。设置页的“测试模型”只验证基础文本连接；图片、工具和工作流需要用实际任务验证，不能从文本成功推断其他能力。

修改 Key、地址、请求头或模型参数后，下一次空闲执行会更新底座配置并保留原历史。正在执行的轮次使用其已冻结的设置。删除或禁用供应商后，新的执行不能继续使用旧 Key；原来手工编辑的 CLI 条目不会被猜测删除，发生冲突时会明确报错。

## 给贡献者

配置规则见 [通信契约](step-provider-communication-spec.md)。新增服务优先使用协议和配置参数，避免添加供应商名称或模型名称分支。新增协议行为需要提供可控 HTTP 服务和真实 Step RPC 的回归证据。

运行真实协议测试时设置 `STEP_TEST_CLI` 指向已安装的 Step 可执行文件，然后从仓库根目录执行：

```text
node --test packages/stepcode-adapter/suites/provider-wire-contract.mjs packages/stepcode-adapter/suites/provider-wire-tool-integrity.mjs packages/stepcode-adapter/suites/provider-wire-owner.mjs
```

没有设置该变量时真实运行时测试会明确跳过，跳过不能计为验证成功。开发测试只使用隔离配置、假 Key、本机 HTTP 服务和临时标记文件，禁止把真实凭据写进测试或提交。当前 Windows 运行时已验证；其他平台与不同 Step 版本需要执行相同契约测试后确认。
