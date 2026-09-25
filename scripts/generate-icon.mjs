import sharp from "sharp";
import pngToIco from "png-to-ico";
import { writeFileSync, mkdirSync } from "fs";

// Lucide Feather icon path (from lucide-react source)
// Rendered as white on #E63946 rounded-rect background
const SIZE = 512;
const PADDING = 96;
const ICON_SIZE = SIZE - PADDING * 2;
const RADIUS = 96;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}" fill="#E63946"/>
  <g transform="translate(${PADDING}, ${PADDING}) scale(${ICON_SIZE / 24})" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/>
    <line x1="16" y1="8" x2="2" y2="22"/>
    <line x1="17.5" y1="15" x2="9" y2="15"/>
  </g>
</svg>`;

const pngBuffer = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();

mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", pngBuffer);

// Generate multi-size ICO
const sizes = [16, 32, 48, 64, 128, 256];
const pngBuffers = await Promise.all(
  sizes.map((s) => sharp(Buffer.from(svg)).resize(s, s).png().toBuffer()),
);

const icoBuffer = await pngToIco(pngBuffers);
writeFileSync("build/icon.ico", icoBuffer);

console.log("Generated build/icon.ico and build/icon.png");
