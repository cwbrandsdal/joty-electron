// Renders the desktop app icon from scripts/icon-design.mjs ("j▌" in paper on redline):
//   build/icon.ico  app/installer/uninstaller icon (electron-builder), window and tray
//                   icon at runtime (copied to resources/icon.ico, see electron/main.cjs)
//   build/icon.png  1024 px, for electron-builder targets that want a PNG
// Each size is laid out on its own pixel grid, so nothing is downscaled.
// Run: node scripts/generate-icon.mjs
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { iconSvg } from "./icon-design.mjs";

const buildDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
const ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256];

const render = (size) =>
  sharp(Buffer.from(iconSvg(size)))
    .png()
    .toBuffer();

mkdirSync(buildDir, { recursive: true });
writeFileSync(path.join(buildDir, "icon.png"), await render(1024));
writeFileSync(
  path.join(buildDir, "icon.ico"),
  await pngToIco(await Promise.all(ICO_SIZES.map(render))),
);

console.log(`Generated build/icon.ico (${ICO_SIZES.join(", ")}) and build/icon.png (1024)`);
