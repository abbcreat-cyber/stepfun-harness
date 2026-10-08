import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveDesktopProductIdentity,
  resolveWindowsAppUserModelIdForFlavor,
} from "./desktop-product-identity.mjs";

const resource = (path) => readFile(new URL(`../build/${path}`, import.meta.url));
test("默认应用、窗口和安装器均使用星辰图标，不依赖后端开关", async () => {
  const png = await resource("step/icon.png");
  const ico = await resource("step/icon.ico");
  for (const path of ["icon.png", "icon_windows.png", "icon_installer.png"])
    assert.deepEqual(await resource(path), png);
  for (const path of ["icon.ico", "icon_installer.ico"])
    assert.deepEqual(await resource(path), ico);
  assert.deepEqual(
    await readFile(new URL("../../ui/src/assets/step-app-icon.png", import.meta.url)),
    png,
  );
  assert.equal(ico.readUInt16LE(2), 1);
  const icoSizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const offset = 6 + index * 16;
    const size = ico[offset] || 256;
    assert.equal(ico[offset + 1] || 256, size);
    const payload = ico.readUInt32LE(offset + 12);
    assert.equal(ico.readUInt32BE(payload + 16), size);
    assert.equal(ico.readUInt32BE(payload + 20), size);
    return size;
  });
  assert.deepEqual(icoSizes, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const image = await resource(`icons/${size}x${size}.png`);
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image.readUInt32BE(20), size);
  }
  const icns = await resource("icon.icns");
  assert.equal(icns.subarray(0, 4).toString(), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.deepEqual(await resource("icon_installer.icns"), icns);
});
test("打包与运行时共享独立的 Step Code Shell 身份", () => {
  for (const [flavor, env, id] of [
    ["production", { ZCODE_ENV: "production" }, "dev.stepcode.desktop.stepstars"],
    ["preview", { ZCODE_ENV: "test" }, "dev.stepcode.desktop.stepstars.preview"],
  ]) {
    assert.equal(resolveDesktopProductIdentity(env).appId, id);
    assert.equal(resolveWindowsAppUserModelIdForFlavor(flavor), id);
    assert.equal(
      resolveDesktopProductIdentity({ ...env, STEP_BACKEND: "stepcode-local" }).appId,
      id,
    );
  }
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("production", { isPackaged: false }),
    "cn.aminer.stepcode",
  );
});
