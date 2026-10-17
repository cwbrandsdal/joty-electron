// Disk documents are owned by the main process, never the notes cache/outbox.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const MAX_BYTES = 5 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (text) => text.replace(/\r\n?|\n/g, "\n");

function readDocument(filePath) {
  const canonicalPath = fs.realpathSync(filePath);
  const stat = fs.statSync(canonicalPath);
  if (!stat.isFile()) throw new Error("Choose a text or Markdown file.");
  if (stat.size > MAX_BYTES) throw new Error("Files must be smaller than 5 MB.");
  const bytes = fs.readFileSync(canonicalPath);
  if (bytes.length > MAX_BYTES) throw new Error("Files must be smaller than 5 MB.");
  let encoding = "utf-8";
  let bom = Buffer.alloc(0);
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) bom = bytes.subarray(0, 3);
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    encoding = "utf-16le";
    bom = bytes.subarray(0, 2);
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    encoding = "utf-16be";
    bom = bytes.subarray(0, 2);
  }
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(bom.length),
    );
  } catch {
    throw new Error(
      "This file is not UTF-8 or UTF-16 text. Convert it to UTF-8 before opening it in Joty.",
    );
  }
  // Control bytes indicate binary data, except normal text whitespace.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text))
    throw new Error("This looks like a binary file. Joty opens text and Markdown files.");
  const endings = text.match(/\r\n|\r|\n/g) ?? [];
  const counts = new Map();
  for (const ending of endings) counts.set(ending, (counts.get(ending) ?? 0) + 1);
  const newline = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "\n";
  const body = normalize(text);
  return {
    path: canonicalPath,
    name: path.basename(canonicalPath),
    body,
    savedBody: body,
    encoding,
    bom,
    newline,
    hash: hash(bytes),
    mode: stat.mode,
  };
}

function encodeDocument(doc, body) {
  const text = body.replace(/\n/g, doc.newline);
  const bytes = Buffer.from(text, doc.encoding === "utf-8" ? "utf8" : "utf16le");
  if (doc.encoding === "utf-16be") bytes.swap16();
  const result = Buffer.concat([doc.bom, bytes]);
  if (result.length > MAX_BYTES) throw new Error("The edited file exceeds the 5 MB limit.");
  return result;
}

function saveDocument(doc) {
  if (doc.body === doc.savedBody) return;
  const bytes = encodeDocument(doc, doc.body);
  const checkUnchanged = () => {
    if (hash(fs.readFileSync(doc.path)) !== doc.hash) {
      throw new Error(
        "This file changed outside Joty. Your edits are still here. Copy them into Joty or elsewhere, then reload the file before saving.",
      );
    }
  };
  checkUnchanged();
  fs.accessSync(doc.path, fs.constants.W_OK);
  const temporary = path.join(
    path.dirname(doc.path),
    `.${path.basename(doc.path)}.${randomUUID()}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", doc.mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    checkUnchanged();
    fs.renameSync(temporary, doc.path);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  doc.hash = hash(bytes);
  doc.savedBody = doc.body;
}

function fileArguments(argv, workingDirectory, defaultApp = false) {
  return argv
    .slice(1)
    .filter((arg) => arg && !arg.startsWith("-"))
    .slice(defaultApp ? 1 : 0)
    .filter((arg) => !/^[a-z][a-z\d+.-]*:\/\//i.test(arg))
    .map((arg) => path.resolve(workingDirectory, arg));
}

module.exports = { MAX_BYTES, readDocument, saveDocument, fileArguments };
