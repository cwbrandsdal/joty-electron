const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseColor, overlayColor, backgroundColor, supportsMica } = require("./window-chrome.cjs");

test("skin colours: CSS for the overlay, #AARRGGBB for the window background", () => {
  // titleBarOverlay takes CSS colours; setBackgroundColor reads 8-digit hex as ARGB.
  const pad = parseColor("#e2e8d6");
  assert.equal(overlayColor(pad), "rgba(226, 232, 214, 1)");
  assert.equal(backgroundColor(pad), "#ffe2e8d6");
  const vellum = parseColor("rgba(240, 243, 240, 0.56)");
  assert.equal(overlayColor(vellum), "rgba(240, 243, 240, 0.56)");
  assert.equal(backgroundColor(vellum), "#8ff0f3f0");
  assert.equal(backgroundColor(vellum, { opaque: true }), "#fff0f3f0");
  assert.equal(overlayColor(parseColor("#11223380")), "rgba(17, 34, 51, 0.502)");
  assert.equal(overlayColor(parseColor("#abc")), "rgba(170, 187, 204, 1)");
  assert.equal(backgroundColor(parseColor("rgb(13 31 49 / 50%)")), "#800d1f31");
  assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColor("url(x)"), null);
  assert.equal(parseColor("red; drop"), null);
});

test("Mica needs Windows 11 22H2", () => {
  assert.equal(supportsMica("win32", "10.0.26200"), true);
  assert.equal(supportsMica("win32", "10.0.22621"), true);
  assert.equal(supportsMica("win32", "10.0.22000"), false);
  assert.equal(supportsMica("darwin", "24.0.0"), false);
});
