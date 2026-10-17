import type { Platform } from "@/platform/platform";
import { UpdateBanner } from "./update-banner";
import { SettingsPage } from "./settings-page";
import { lazy } from "react";
import { localFileStore } from "./local-file-store";

const LocalFileEditor = lazy(() =>
  import("./local-file-page").then((m) => ({ default: m.LocalFilePage })),
);

export const desktopPlatform: Platform = {
  name: "desktop",
  Banner: UpdateBanner,
  SettingsPage,
  LocalFileEditor,
  localFiles: localFileStore,
  openLocalFiles: () => void window.joty?.files?.open(),
  onMenuAction: (handler) => window.joty?.onMenuAction?.(handler) ?? (() => {}),
  onOpenNote: (handler) => window.joty?.onOpenNote?.(handler) ?? (() => {}),
  printNoteToPdf: () => void window.joty?.printNoteToPdf?.(),
};
