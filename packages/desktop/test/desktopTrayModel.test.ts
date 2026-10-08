import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopCommandIds, desktopMenuMessageIds } from "@zcode/shared";
import { buildDesktopTrayMenu } from "../src/main/desktopTrayModel.ts";
import { buildDesktopTaskbarDetails } from "../src/main/desktopWindowBranding.ts";

test("tray removes about and data clearing and routes update to existing command", () => {
  const commands: string[] = [];
  const menu = buildDesktopTrayMenu({ getLabel: id => id, updatesEnabled: true, showWindow: () => {}, execute: command => commands.push(command), quit: () => {} });
  assert.deepEqual(menu.filter(item => item.type !== "separator").map(item => item.label), [desktopMenuMessageIds.trayOpenZCode, desktopMenuMessageIds.fileNewTask, desktopMenuMessageIds.fileOpenWorkspace, desktopMenuMessageIds.helpCheckForUpdates, desktopMenuMessageIds.trayQuit]);
  const update = menu.find(item => item.label === desktopMenuMessageIds.helpCheckForUpdates)!;
  (update.click as () => void)();assert.deepEqual(commands, [DesktopCommandIds.CheckForUpdates]);
  const preview = buildDesktopTrayMenu({ getLabel: id => id, updatesEnabled: false, showWindow: () => {}, execute: () => {}, quit: () => {} });
  assert.ok(!preview.some(item => item.label === desktopMenuMessageIds.helpCheckForUpdates));
  assert.ok(!preview.some((item, index) => item.type === "separator" && preview[index + 1]?.type === "separator"));
});

test("Shell branding binds ICO and a stable relaunch command together", () => {
  const details = buildDesktopTaskbarDetails({ appId: "dev.stepcode.app", iconPath: "D:/App Brand/star.ico", executablePath: "D:/App Brand/Step Code.exe", launcherPath: "D:/App Brand/launch.vbs" });
  assert.equal(details.appIconPath, "D:/App Brand/star.ico");
  assert.equal(details.relaunchCommand, '"C:\\Windows\\System32\\wscript.exe" "D:/App Brand/launch.vbs"');
  assert.equal(details.relaunchDisplayName, "Step Code");assert.equal(details.appId, "dev.stepcode.app");
  assert.equal(buildDesktopTaskbarDetails({ appId: "test", iconPath: "star.ico", executablePath: "D:/App Brand/Step Code.exe" }).relaunchCommand, '"D:/App Brand/Step Code.exe"');
});
