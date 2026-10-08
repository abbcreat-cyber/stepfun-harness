import test from "node:test";
import assert from "node:assert/strict";
import { shouldShowStepFirstUse, stepFirstUseCompletionSettings, isStepFirstUseEndpointValid, stepFirstUseCustomConfig } from "../src/lib/stepFirstUse.ts";

test("首次 Step 启动需要欢迎，既有用户与非 Step 不被重新引导", () => {
  assert.equal(shouldShowStepFirstUse({}, true), true);
  assert.equal(shouldShowStepFirstUse(null, true), false);
  assert.equal(shouldShowStepFirstUse({}, false), false);
  assert.equal(shouldShowStepFirstUse({ stepWelcomeCompleted: true }, true), false);
  assert.equal(shouldShowStepFirstUse({ onboardingOccupation: "developer" }, true), false);
  assert.equal(shouldShowStepFirstUse({ lastWorkspaceSession: [{ kind: "local", workspacePath: "D:/work" }] }, true), false);
});
test("稍后设置只写引导与运行域，既有运行域保留，不伪造登录或 Key", () => {
  assert.deepEqual(stepFirstUseCompletionSettings({ providerFamilyDomain: "zai" }, "zh-CN", 12), { stepWelcomeCompleted: true, providerFamilyDomain: "zai", providerFamilyDomainMigrated: true, providerFamilyDomainUpdatedAt: 12 });
  assert.equal(stepFirstUseCompletionSettings(null, "zh-CN", 12).providerFamilyDomain, "bigmodel");
  assert.equal(stepFirstUseCompletionSettings(null, "en-US", 12).providerFamilyDomain, "zai");
});
test("通用服务接入接受 HTTPS 与本机 HTTP 网关，错误地址不提前创建配置", () => {
  for (const value of ["https://api.example.com/v1", "http://127.0.0.1:3090/v1"]) assert.equal(isStepFirstUseEndpointValid(value), true);
  for (const value of ["", "file:///D:/key", "ftp://example.com", "https://user:secret@example.com/v1"]) assert.equal(isStepFirstUseEndpointValid(value), false);
});

test("创建供应商遵守正式接口：不指定受保护分组，模型成员由后续正式接口添加", () => {
  const config = stepFirstUseCustomConfig(" fixture ", " https://example.com/v1 ", "openai-chat-completions");
  assert.deepEqual(config, { access: { type: "api-key", apiKey: "fixture" }, api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" }, visibility: "visible" });
  assert.equal("group" in config, false);
  assert.equal("builtinModelIds" in config, false);
});
