import test from "node:test";
import assert from "node:assert/strict";
import { getZCodeToolFamilyForName, normalizeZCodeToolName } from "@zcode/shared";
test("原生 PowerShell 走现有终端卡片，名称不伪装为 Bash", () => {
  assert.equal(normalizeZCodeToolName("powershell"), "PowerShell");
  assert.equal(getZCodeToolFamilyForName("powershell"), "shell");
  assert.equal(getZCodeToolFamilyForName("Bash"), "shell");
});
