import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const { PNG } = requireDesktop("pngjs");

test("浅深素材有真实透明外沿、同一画布且主体居中", async () => {
  let dimensions;
  for (const mode of ["light", "dark"]) {
    const png = PNG.sync.read(await readFile(new URL(`../../ui/src/assets/step-welcome-${mode}.png`, import.meta.url)));
    if (dimensions) assert.deepEqual([png.width, png.height], dimensions);
    dimensions = [png.width, png.height];
    const alpha = (x, y) => png.data[(y * png.width + x) * 4 + 3];
    for (const [x, y] of [[0, 0], [png.width - 1, 0], [0, png.height - 1], [png.width - 1, png.height - 1]]) assert.equal(alpha(x, y), 0);
    let minX = png.width, maxX = 0, minY = png.height, maxY = 0;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      if (alpha(x, y) < 64) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const centerX = (minX + maxX) / 2 / png.width, centerY = (minY + maxY) / 2 / png.height;
    assert.ok(centerX > 0.45 && centerX < 0.55, `${mode} 横向主体应在画布中心`);
    assert.ok(centerY > 0.45 && centerY < 0.55, `${mode} 纵向主体应在画布中心`);
  }
});

test("欢迎区使用独立透明素材，无截图、固定底板或反相滤镜", async () => {
  const css = await readFile(new URL("../../ui/src/v4/step-welcome-reference.css", import.meta.url), "utf8");
  const source = await readFile(new URL("../../ui/src/v4/ConversationDraftEmptyState.tsx", import.meta.url), "utf8");
  assert.match(css, /background: transparent/);
  assert.match(css, /object-fit: contain/);
  assert.match(css, /object-position: center/);
  assert.match(css, /html\.dark \.step-welcome-art-dark/);
  assert.ok(!css.includes("invert(") && !source.includes("step5-preview-reference"));
  assert.match(source, /step-welcome-light\.png/); assert.match(source, /step-welcome-dark\.png/);
});
