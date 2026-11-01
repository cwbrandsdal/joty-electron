import type { Platform } from "@/platform/platform";
import type { JotyApi } from "./electron-api";

type WindowChrome = NonNullable<Platform["windowChrome"]>;

interface WindowControlsOverlayLike {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

/**
 * The frameless main window's chrome. Until the web app calls setColors /
 * setMaterial itself, the title bar buttons follow the skin on <html
 * data-skin> (--desk behind them, --ink for the glyphs, Mica for Vellum).
 * The first explicit call hands that job to the app.
 */
export function createWindowChrome(bridge: JotyApi): WindowChrome {
  let appColors = false;
  let appMaterial = false;
  let applied = "";
  const warn = (error: unknown) =>
    void bridge.log("warn", `[chrome] ${error instanceof Error ? error.message : String(error)}`);

  const followSkin = () => {
    const root = document.documentElement;
    const skin = root.dataset.skin;
    if (!skin || (appColors && appMaterial)) return;
    const css = getComputedStyle(root);
    const color = css.getPropertyValue("--desk").trim();
    const symbolColor = css.getPropertyValue("--ink").trim();
    const key = `${skin}|${color}|${symbolColor}`;
    if (key === applied) return;
    applied = key;
    if (!appColors && color && symbolColor) {
      bridge.windowChrome.setColors({ color, symbolColor }).catch(warn);
    }
    if (!appMaterial) {
      bridge.windowChrome.setMaterial(skin === "vellum" ? "mica" : "none").catch(warn);
    }
  };
  new MutationObserver(followSkin).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-skin"],
  });
  followSkin();

  return {
    // Measured from Window Controls Overlay, so it stays right under zoom.
    get controlsWidth() {
      const overlay = (
        navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike }
      ).windowControlsOverlay;
      if (overlay?.visible) {
        const rect = overlay.getTitlebarAreaRect();
        if (rect.width > 0) return Math.max(0, Math.round(window.innerWidth - rect.x - rect.width));
      }
      return bridge.windowChrome.controlsWidth;
    },
    setColors(colors) {
      appColors = true;
      bridge.windowChrome.setColors(colors).catch(warn);
    },
    setMaterial(material) {
      appMaterial = true;
      bridge.windowChrome.setMaterial(material).catch(warn);
    },
  };
}
