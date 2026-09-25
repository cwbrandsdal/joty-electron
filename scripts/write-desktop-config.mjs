// Generates electron/desktop-config.json for the main process from the same
// VITE_* variables the renderer build uses (CI sets them as env vars; local
// builds fall back to .env.production / .env). Runs as part of `npm run build`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "electron", "desktop-config.json");

function parseEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    values[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

const fileValues = {
  ...parseEnvFile(path.join(root, ".env")),
  ...parseEnvFile(path.join(root, ".env.production")),
  ...parseEnvFile(path.join(root, ".env.production.local")),
};

const workosClientId = process.env.VITE_WORKOS_CLIENT_ID || fileValues.VITE_WORKOS_CLIENT_ID || "";
const apiBaseUrl =
  process.env.VITE_API_BASE_URL || fileValues.VITE_API_BASE_URL || "https://api.joty.io/api";

if (!workosClientId) {
  console.error(
    "write-desktop-config: VITE_WORKOS_CLIENT_ID is not set (env or .env.production). " +
      "The packaged app cannot sign in without it.",
  );
  process.exit(1);
}

fs.writeFileSync(
  out,
  JSON.stringify({ workosClientId, apiBaseUrl, generatedAt: new Date().toISOString() }, null, 2) +
    "\n",
);
console.log(`write-desktop-config: wrote ${path.relative(root, out)} (api=${apiBaseUrl})`);
