const { redactSecrets } = require("./redact.cjs");

// Renderer output in the main log: console warnings and errors, crashes and
// `joty.log` bridge calls. The renderer's own text is redacted as it arrived,
// before the `[renderer:name]` tag and source URL are added (a value that is
// recognized only on a line of its own would otherwise be missed).

/** A `joty.log` message is read up to this far (whole lines)… */
const RENDERER_SCAN_CHARS = 16 * 1024;
/** …and cut to this length after redaction. */
const RENDERER_MAX_CHARS = 2000;

// Electron ≥ 35 passes an event object with details; older versions pass
// positional arguments.
function attachRendererLogging(webContents, name, log) {
  webContents.on("console-message", (event, ...legacy) => {
    const level = event?.level ?? legacy[0];
    const message = event?.message ?? legacy[1];
    const source = event?.sourceId ?? legacy[3];
    const isError = level === "error" || level === 3;
    const isWarning = level === "warning" || level === 2;
    if (!isError && !isWarning) return;
    // Separate arguments: log.cjs redacts each on its own, then the line.
    const parts = [`[renderer:${name}]`, String(message ?? "")];
    if (source) parts.push(`(${source})`);
    if (isError) log.error(...parts);
    else log.warn(...parts);
  });
  webContents.on("render-process-gone", (_event, details) => {
    log.error(`[renderer:${name}] process gone: ${details.reason} (exit ${details.exitCode})`);
  });
  webContents.on("unresponsive", () => log.warn(`[renderer:${name}] unresponsive`));
  webContents.on("responsive", () => log.info(`[renderer:${name}] responsive again`));
}

/** The `joty:log` bridge call: a renderer message at `level`. */
function logRendererMessage(log, level, message) {
  const text = redactSecrets(String(message), {
    scan: RENDERER_SCAN_CHARS,
    max: RENDERER_MAX_CHARS,
  });
  if (level === "error") log.error("[renderer]", text);
  else if (level === "warn") log.warn("[renderer]", text);
  else log.info("[renderer]", text);
}

module.exports = {
  RENDERER_MAX_CHARS,
  RENDERER_SCAN_CHARS,
  attachRendererLogging,
  logRendererMessage,
};
