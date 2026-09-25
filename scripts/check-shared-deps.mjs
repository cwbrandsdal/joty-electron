// The renderer source is shared with ../joty-web, so the runtime libraries
// both projects install must be identical: Vite dedupes them at build time and
// TypeScript only unifies duplicate packages when name and version match.
// This check fails fast when the two package trees drift. Runs from `npm run lint`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.resolve(root, "../joty-web");

const SHARED = [
  "react",
  "react-dom",
  "react-router",
  "@tanstack/react-query",
  "@tanstack/react-query-persist-client",
  "idb-keyval",
];

function installedVersion(base, name) {
  const file = path.join(base, "node_modules", name, "package.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")).version;
}

if (!fs.existsSync(path.join(webRoot, "node_modules"))) {
  console.error(`check-shared-deps: ${webRoot} has no node_modules — run npm install there first.`);
  process.exit(1);
}

let drift = 0;
for (const name of SHARED) {
  const here = installedVersion(root, name);
  const web = installedVersion(webRoot, name);
  if (here !== web) {
    drift++;
    console.error(
      `check-shared-deps: ${name} is ${here ?? "missing"} here but ${web ?? "missing"} in joty-web`,
    );
  }
}

if (drift) {
  console.error(
    "check-shared-deps: pin the versions in joty-electron/package.json to joty-web's and run npm install.",
  );
  process.exit(1);
}
console.log(`check-shared-deps: ${SHARED.length} shared packages match joty-web.`);
