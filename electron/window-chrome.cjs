// Title bar overlay and backdrop helpers for the frameless main window.
const os = require("node:os");

/** Height of the web app's bar in CSS pixels; the overlay matches it. */
const TITLE_BAR_HEIGHT = 48;
/** Width of the three Windows caption buttons (46 DIP each). */
const CAPTION_CONTROLS_WIDTH = 138;

/**
 * Parse the CSS colours the skins use: #rgb, #rgba, #rrggbb, #rrggbbaa,
 * rgb()/rgba() (comma or space syntax) and transparent. Returns
 * { r, g, b, a } (a in 0..1) or null for anything else.
 */
function parseColor(input) {
  if (typeof input !== "string" || input.length > 64) return null;
  const value = input.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const byte = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
    value,
  );
  if (!m) return null;
  const channel = (v) => (v.endsWith("%") ? (parseFloat(v) * 255) / 100 : parseFloat(v));
  const alpha =
    m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  const [r, g, b] = [m[1], m[2], m[3]].map(channel);
  if (![r, g, b, alpha].every(Number.isFinite)) return null;
  const clamp = (n, max) => Math.max(0, Math.min(max, n));
  return {
    r: clamp(Math.round(r), 255),
    g: clamp(Math.round(g), 255),
    b: clamp(Math.round(b), 255),
    a: clamp(alpha, 1),
  };
}

const hex2 = (n) => Math.round(n).toString(16).padStart(2, "0");

/** For titleBarOverlay, which takes a CSS colour. */
function overlayColor(color) {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.round(color.a * 1000) / 1000})`;
}

/**
 * For setBackgroundColor / backgroundColor, which read 8-digit hex as
 * #AARRGGBB (unlike CSS). `opaque` drops the alpha.
 */
function backgroundColor(color, { opaque = false } = {}) {
  return `#${hex2(opaque ? 255 : color.a * 255)}${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
}

/** Mica needs Windows 11 22H2 (build 22621) or later. */
function supportsMica(platform = process.platform, release = os.release()) {
  if (platform !== "win32") return false;
  const build = Number(String(release).split(".")[2]);
  return Number.isFinite(build) && build >= 22621;
}

module.exports = {
  TITLE_BAR_HEIGHT,
  CAPTION_CONTROLS_WIDTH,
  parseColor,
  overlayColor,
  backgroundColor,
  supportsMica,
};
