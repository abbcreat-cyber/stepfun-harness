// 使用获批画稿生成所有平台资源；仅裁透明边距、等比缩放，不重新绘制品牌图形。
// 运行：pnpm --dir packages/desktop exec electron scripts/generate-branding-icons.cjs
const { app, nativeImage } = require("electron");
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const { resolve } = require("node:path");
const { tmpdir } = require("node:os");

const build = resolve(__dirname, "../build");
app.setPath(
  "userData",
  process.env.STEPCODE_BRANDING_CACHE || resolve(tmpdir(), "stepcode-branding-converter"),
);
app
  .whenReady()
  .then(async () => {
    const source = nativeImage.createFromBuffer(
      await readFile(resolve(build, "step/approved-step-stars-v2.png")),
    );
    if (source.isEmpty()) throw new Error("approved icon cannot be decoded");
    const { width, height } = source.getSize();
    const bitmap = source.toBitmap();
    let left = width,
      top = height,
      right = -1,
      bottom = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        // 生成画稿外侧有 alpha 1–8 的不可见噪点；不能让它们把透明边距算入主体。
        if (bitmap[(y * width + x) * 4 + 3] > 8) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    if (right < 0) throw new Error("approved icon has no visible pixels");
    const cropped = source.crop({
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1,
    });
    const side = 1024,
      content = 960;
    const factor = content / Math.max(right - left + 1, bottom - top + 1);
    const scaled = cropped.resize({
      width: Math.round((right - left + 1) * factor),
      height: Math.round((bottom - top + 1) * factor),
      quality: "best",
    });
    const scaledSize = scaled.getSize(),
      pixels = scaled.toBitmap(),
      canvas = Buffer.alloc(side * side * 4);
    const offsetX = Math.floor((side - scaledSize.width) / 2),
      offsetY = Math.floor((side - scaledSize.height) / 2);
    for (let y = 0; y < scaledSize.height; y++)
      pixels.copy(
        canvas,
        ((y + offsetY) * side + offsetX) * 4,
        y * scaledSize.width * 4,
        (y + 1) * scaledSize.width * 4,
      );
    const image = nativeImage.createFromBitmap(canvas, { width: side, height: side });
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024];
    const images = new Map(
      sizes.map((size) => [
        size,
        image.resize({ width: size, height: size, quality: "best" }).toPNG(),
      ]),
    );
    await mkdir(resolve(build, "icons"), { recursive: true });
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024])
      await writeFile(resolve(build, `icons/${size}x${size}.png`), images.get(size));
    const icoSizes = sizes.filter((size) => size <= 256),
      directory = Buffer.alloc(6 + 16 * icoSizes.length);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(icoSizes.length, 4);
    let offset = directory.length;
    icoSizes.forEach((size, index) => {
      const pos = 6 + index * 16,
        png = images.get(size);
      directory[pos] = directory[pos + 1] = size === 256 ? 0 : size;
      directory.writeUInt16LE(1, pos + 4);
      directory.writeUInt16LE(32, pos + 6);
      directory.writeUInt32LE(png.length, pos + 8);
      directory.writeUInt32LE(offset, pos + 12);
      offset += png.length;
    });
    const ico = Buffer.concat([directory, ...icoSizes.map((size) => images.get(size))]);
    const chunks = [];
    for (const [type, size] of [
      ["ic07", 128],
      ["ic08", 256],
      ["ic09", 512],
      ["ic10", 1024],
    ]) {
      const png = images.get(size),
        header = Buffer.alloc(8);
      header.write(type);
      header.writeUInt32BE(png.length + 8, 4);
      chunks.push(header, png);
    }
    const body = Buffer.concat(chunks),
      header = Buffer.alloc(8);
    header.write("icns");
    header.writeUInt32BE(body.length + 8, 4);
    const icns = Buffer.concat([header, body]);
    for (const name of ["step/icon.png", "icon.png", "icon_windows.png", "icon_installer.png"])
      await writeFile(resolve(build, name), images.get(1024));
    for (const name of ["step/icon.ico", "icon.ico", "icon_installer.ico"])
      await writeFile(resolve(build, name), ico);
    for (const name of ["icon.icns", "icon_installer.icns"])
      await writeFile(resolve(build, name), icns);
    await writeFile(resolve(build, "../../ui/src/assets/step-app-icon.png"), images.get(1024));
    console.log(
      JSON.stringify({
        source: { width, height },
        crop: { left, top, right, bottom },
        normalized: side,
        icoSizes,
      }),
    );
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
