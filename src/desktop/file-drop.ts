import type { JotyApi } from "./electron-api";

// Mirrors TEXT_EXTENSIONS in electron/text-files.cjs (the main process makes
// the final call by sniffing the content of anything not listed here).
const TEXT_EXTENSIONS = new Set(
  (
    "txt log md markdown mdx json jsonc json5 ndjson csv tsv xml yml yaml toml ini conf cfg " +
    "config properties env editorconfig gitignore gitattributes ps1 psm1 psd1 sql cs csx " +
    "csproj fsproj vbproj sln props targets ts tsx mts cts js jsx mjs cjs py sh bash zsh bat " +
    "cmd html htm css scss less svg vue go rs java kt c h cpp hpp rb php lua r tex rst " +
    "canvas joty diff patch"
  ).split(" "),
);

const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");

function droppedPaths(bridge: JotyApi, event: DragEvent): string[] {
  return Array.from(event.dataTransfer?.files ?? [])
    .map((file) => bridge.files.pathForFile(file))
    .filter(Boolean);
}

function isTextName(path: string) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Files dropped on the window open as file sheets when they are text. Known
 * text files are taken before the page sees the drop (so the editor does not
 * paste their content); anything else goes to the page first (images for a
 * canvas, say), and what the page leaves is offered to the main process,
 * which opens it only if it is text. A drop never navigates the window.
 */
export function installFileDrop(bridge: JotyApi): () => void {
  const open = (paths: string[]) => {
    if (paths.length) bridge.files.openDropped(paths).catch(() => {});
  };
  const onDropCapture = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    const paths = droppedPaths(bridge, event);
    if (!paths.length || !paths.every(isTextName)) return;
    event.preventDefault();
    event.stopPropagation();
    open(paths);
  };
  const onDragOver = (event: DragEvent) => {
    if (!hasFiles(event) || event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event) || event.defaultPrevented) return;
    event.preventDefault();
    open(droppedPaths(bridge, event));
  };
  window.addEventListener("drop", onDropCapture, true);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  return () => {
    window.removeEventListener("drop", onDropCapture, true);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
  };
}
