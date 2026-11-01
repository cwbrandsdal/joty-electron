// Local OCR through Windows' built-in engine (ocr-win.ps1 in Windows
// PowerShell 5.1). The image goes to a temp file that is removed right
// after; recognized text is never logged. Resolves "" when OCR is
// unavailable (no language pack, policy, not Windows).
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const TIMEOUT_MS = 45000;
let queue = Promise.resolve();

function windowsPowerShell() {
  return path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function recognize(png, { scriptPath, tmpDir = os.tmpdir(), log }) {
  if (process.platform !== "win32") return "";
  const image = path.join(tmpDir, `joty-ocr-${randomUUID()}.png`);
  await fsp.writeFile(image, png, { flag: "wx", mode: 0o600 });
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        windowsPowerShell(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-ImagePath",
          image,
        ],
        { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
        (error, out, err) => {
          if (error)
            reject(
              new Error(
                String(err || error.message)
                  .trim()
                  .slice(0, 300),
              ),
            );
          else resolve(out);
        },
      );
    });
    const value = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    const lines = Array.isArray(value.lines) ? value.lines : value.lines ? [value.lines] : [];
    return lines.map(String).join("\n") || String(value.text ?? "");
  } catch (error) {
    log?.warn(`[ocr] unavailable: ${error.message}`);
    return "";
  } finally {
    await fsp.rm(image, { force: true }).catch(() => {});
  }
}

/** OCR one PNG at a time (each run starts a PowerShell process). */
function runOcr(png, options) {
  const next = queue.then(() => recognize(png, options));
  queue = next.catch(() => {});
  return next;
}

module.exports = { runOcr };
