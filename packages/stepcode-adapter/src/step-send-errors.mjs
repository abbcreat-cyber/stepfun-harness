/* 发送/模型选择错误分类。供应商选择是运行时事实，错误引导不能写死官方品牌。
 * Derives from zai-org/ZCode, Apache-2.0. */
function hasStatusCode(text, code) {
  return new RegExp(`(?:^|[^0-9])${code}(?:[^0-9]|$)`).test(text);
}

/** 稳定类别与原文供诊断使用，展示只引用当前供应商/模型。 */
export function classifyStepSendFault(error, options = {}) {
  const raw = typeof error?.message === "string" ? error.message : String(error);
  const text = raw.toLowerCase();
  const modelId = options.modelId?.trim() || "（未知模型）";
  const provider = options.providerName?.trim() || options.providerId?.trim();
  const target = provider ? `供应商 ${provider}` : "当前供应商";
  let code, message;
  if (["model_projection_failed", "model_admission_unavailable", "model_selection_unavailable", "model_configuration_changed"].includes(error?.code)) {
    code = error.code; message = "模型配置尚未可用，请修正并保存配置后再次发送或继续队列。";
  } else if (hasStatusCode(text, 401) || text.includes("unauthorized") || text.includes("invalid api key") || text.includes("no api key")) {
    code = "invalid_credentials";
    message = `API Key 无效或已过期，请到${target}的设置检查认证信息。`;
  } else if (hasStatusCode(text, 403) || text.includes("forbidden") || text.includes("permission") || text.includes("无权限")) {
    code = "permission_denied";
    message = `${target}无法使用模型 ${modelId}，请检查该供应商的访问权限。`;
  } else if (hasStatusCode(text, 404) || text.includes("model not found") || text.includes("not available")) {
    code = "model_unavailable";
    message = `${target}无法使用模型 ${modelId}，请检查供应商地址与模型配置`;
    message += text.includes("model not found") ? "（底座模型配置未注册或已删除）；保存有效配置或选择可用模型后重试。" : "及该模型的访问权限。";
  } else if (hasStatusCode(text, 429) || text.includes("rate limit") || text.includes("too many requests")) {
    code = "rate_limited"; message = `${target}请求过于频繁（限流），请稍等片刻再重试。`;
  } else if (/timeout|timed out|econnrefused|enotfound|eai_again|econnreset|ehostunreach|enetunreach|fetch failed|network/.test(text)) {
    code = "connection_failed"; message = `暂时连不上${target}，请检查网络与供应商地址。超时请求不自动重发，请先确认任务状态。`;
  } else if (text.includes("仍在运行") || text.includes("正在运行")) {
    code = "runtime_busy"; message = "当前对话仍在运行，请等待轮次与待处理交互结束后修改模型配置。";
  } else if (/process exited|process error|stdin error|client stopped/.test(text)) {
    code = "runtime_exited"; message = "模型运行进程已退出，本次请求未确认完成，请检查原始错误与任务状态。";
  } else if (/abort|cancel/.test(text)) {
    code = "cancelled"; message = "本次请求已取消。";
  } else if (hasStatusCode(text, 400)) {
    code = "request_invalid"; message = `${target}拒绝了请求参数，请检查协议、模型能力与兼容设置。`;
  } else {
    code = "send_failed"; message = `发送失败，请检查${target}的连接、认证信息与模型配置。`;
  }
  return { code, raw, message: `${message}\n原始错误：${raw}` };
}

export function classifyStepSendError(error, options = {}) {
  return classifyStepSendFault(error, options).message;
}
