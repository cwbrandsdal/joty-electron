import type { Platform } from "@/platform/platform";
import { UpdateBanner } from "./update-banner";
import { SettingsPage } from "./settings-page";

export const desktopPlatform: Platform = {
  name: "desktop",
  Banner: UpdateBanner,
  SettingsPage,
  onMenuAction: (handler) => window.joty?.onMenuAction?.(handler) ?? (() => {}),
};
