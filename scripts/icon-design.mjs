// The Joty 2.x app icon: "j▌", the first letter of the sidebar wordmark (IBM Plex Mono
// Bold "j") and its block text cursor, in paper on the redline orange.
//
// The glyph is built from rectangles measured in IBM Plex Mono Bold's font units
// (1000/em), not from a font, so every size is laid out on its own pixel grid: each
// straight edge lands on a whole pixel at the size it is rendered at. The smallest sizes
// get a larger, simplified figure (square dot, square hook) instead of a blurry
// downscale. Used by scripts/generate-icon.mjs here, and by joty-work/design/icon for
// the web and iOS icons.

export const REDLINE = "#e0551f"; // --redline, light skins
export const REDLINE_DARK = "#ff8752"; // --redline, dark skins
export const PAPER = "#f7f6f3"; // --sheet, Paper skin

// IBM Plex Mono Bold "j" plus cursor, in font units. The figure runs from the top of the
// dot (y -751) to the bottom of the descender (y 200); the cursor spans the same height.
const U = {
  height: 951,
  stem: 148, // stem width
  serif: 115, // thickness of the top serif and of the hook
  dotOverhang: 15, // the dot is this much wider than the stem on each side
  dotGap: 66, // between dot and serif
  reach: 200, // how far serif and hook reach left of the stem
  hookRadius: 150, // outer corner where the stem turns into the hook
  gap: 147, // stem to cursor
  cursor: 380, // cursor width
};

// Hand tuning for the small sizes (tray, title bar, taskbar, favicon): figure height in
// pixels, optional stem/serif widths, corner radii. Larger sizes use 56.25 % of the
// canvas and the font's own proportions and radii.
const SMALL = {
  16: { height: 12, dotRadius: 0, hookRadius: 0 },
  20: { height: 14, stem: 3, serif: 2, dotRadius: 0, hookRadius: 0 },
  24: { height: 16, stem: 3, serif: 2, dotRadius: 0, hookRadius: 1 },
  32: { height: 20, dotRadius: 0.5, hookRadius: 1.5 },
  48: { height: 27, dotRadius: 1, hookRadius: 3 },
};

const PLATE_RADIUS = 0.1875; // rounded-square corner, as a fraction of the size

const round = (n) => Math.round(n * 100) / 100;

/** Pixel geometry of the figure at `size` (top-left origin). */
export function iconLayout(size) {
  const small = SMALL[size];
  const H = small?.height ?? Math.round(size * 0.5625);
  const s = H / U.height;
  const stem = small?.stem ?? Math.max(2, Math.round(U.stem * s));
  const serif = small?.serif ?? Math.max(1, Math.round(U.serif * s));
  const dotW = stem + 2 * Math.round(U.dotOverhang * s);
  const dotH = Math.max(2, Math.round((dotW * 169) / 178));
  const dotGap = Math.max(1, Math.round(U.dotGap * s));
  const reach = Math.max(2, Math.round(U.reach * s));
  const gap = Math.max(2, Math.round(U.gap * s));
  const cursor = Math.max(2 * stem, Math.round(U.cursor * s));
  const W = reach + stem + gap + cursor;
  // Centred, nudged 1 % left: the heavy cursor otherwise pulls the figure right.
  const left = Math.round((size - W) / 2 - size * 0.01);
  const top = Math.floor((size - H) / 2);
  return {
    left,
    top,
    width: W,
    height: H,
    stemLeft: left + reach,
    stem,
    serif,
    serifTop: top + dotH + dotGap,
    dot: { x: left + reach + (stem - dotW) / 2, y: top, w: dotW, h: dotH },
    dotRadius: small ? small.dotRadius : round(0.36 * dotW),
    hookRadius: small ? small.hookRadius : round(U.hookRadius * s),
    cursorLeft: left + reach + stem + gap,
    cursor,
  };
}

/**
 * SVG for the icon at `size` px.
 * plate: "rounded" (desktop, PWA), "square" (full bleed: iOS, maskable, apple-touch) or
 * "none" (transparent: iOS dark and tinted).
 */
export function iconSvg(size, { plate = "rounded", plateColor = REDLINE, color = PAPER } = {}) {
  const g = iconLayout(size);
  const right = g.stemLeft + g.stem;
  const bottom = g.top + g.height;
  const r = g.hookRadius;
  const j = [
    `M${g.left} ${g.serifTop}H${right}V${bottom - r}`,
    r ? `A${r} ${r} 0 0 1 ${right - r} ${bottom}` : "",
    `H${g.left}V${bottom - g.serif}H${g.stemLeft}V${g.serifTop + g.serif}H${g.left}Z`,
  ].join("");
  const rx = plate === "rounded" ? ` rx="${round(size * PLATE_RADIUS)}"` : "";
  const plateEl =
    plate === "none"
      ? ""
      : `\n  <rect width="${size}" height="${size}"${rx} fill="${plateColor}"/>`;
  const d = g.dot;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <!-- Joty 2.x icon: Plex Mono "j" and block cursor, laid out on a ${size} px grid. -->${plateEl}
  <g fill="${color}">
    <path d="${j}"/>
    <rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}"${g.dotRadius ? ` rx="${g.dotRadius}"` : ""}/>
    <rect x="${g.cursorLeft}" y="${g.top}" width="${g.cursor}" height="${g.height}"/>
  </g>
</svg>
`;
}
