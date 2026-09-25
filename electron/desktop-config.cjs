const fs = require("fs");
const path = require("path");

// Main-process configuration (WorkOS client id, API base URL).
//
// Packaged builds read electron/desktop-config.json, which
// scripts/write-desktop-config.mjs generates at build time from the same
// VITE_* variables the renderer is built with. Running from source falls back
// to the .env files Vite would load, so `npm run dev` needs no extra setup.

const GENERATED_FILE = path.join(__dirname, "desktop-config.json");
const PROJECT_ROOT = path.join(__dirname, "..");

function parseEnvFile(file) {
  const values = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return values;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadEnvFiles(mode) {
  // Same precedence as Vite: most specific file wins.
  const files = [`.env.${mode}.local`, `.env.${mode}`, ".env.local", ".env"];
  const merged = {};
  for (const name of files) {
    const values = parseEnvFile(path.join(PROJECT_ROOT, name));
    for (const [key, value] of Object.entries(values)) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

function loadDesktopConfig({ isPackaged }) {
  let generated = {};
  try {
    generated = JSON.parse(fs.readFileSync(GENERATED_FILE, "utf8"));
  } catch {
    // Not generated (running from source) — fall back to env files below.
  }

  const fromEnvFiles = isPackaged ? {} : loadEnvFiles("development");
  const env = process.env;

  const workosClientId =
    env.JOTY_WORKOS_CLIENT_ID ||
    env.VITE_WORKOS_CLIENT_ID ||
    generated.workosClientId ||
    fromEnvFiles.VITE_WORKOS_CLIENT_ID ||
    "";
  const apiBaseUrl =
    env.VITE_API_BASE_URL ||
    generated.apiBaseUrl ||
    fromEnvFiles.VITE_API_BASE_URL ||
    "https://api.joty.io/api";

  return { workosClientId, apiBaseUrl };
}

module.exports = { loadDesktopConfig, parseEnvFile, GENERATED_FILE };
