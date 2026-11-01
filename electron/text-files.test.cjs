const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LARGE_FILE_BYTES,
  detectEncoding,
  detectEol,
  encodeText,
  fileArguments,
  isTextLikeFile,
  normalizeEncoding,
  readTextFile,
  writeTextFile,
} = require("./text-files.cjs");

function dir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "joty-text-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(t, bytes, name = "example file.txt") {
  const file = path.join(dir(t), name);
  fs.writeFileSync(file, bytes);
  return file;
}

const BOM8 = Buffer.from([0xef, 0xbb, 0xbf]);
const sample = "Hei æøå 👋\r\nAndre linje\r\n";
const encodings = {
  "UTF-8": (s) => Buffer.from(s),
  "UTF-8 BOM": (s) => Buffer.concat([BOM8, Buffer.from(s)]),
  "UTF-16 LE": (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]),
  "UTF-16 BE": (s) =>
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, "utf16le").swap16()]),
};

for (const [label, encode] of Object.entries(encodings)) {
  test(`reads and writes ${label} without changing the bytes`, async (t) => {
    const file = fixture(t, encode(sample));
    const { result } = await readTextFile(file);
    assert.equal(result.encoding, label);
    assert.equal(result.eol, "CRLF");
    assert.equal(result.text, "Hei æøå 👋\nAndre linje\n");
    assert.equal(result.truncated, false);
    assert.equal(result.readOnly, false);
    assert.equal(result.size, fs.statSync(file).size);
    await writeTextFile(file, result.text, { encoding: result.encoding, eol: result.eol });
    assert.deepEqual(fs.readFileSync(file), encode(sample));
  });
}

test("windows-1252 is detected when the bytes are not UTF-8, and round-trips", async (t) => {
  // "Blåbær – €5" in Windows-1252 (– is 0x96, € is 0x80).
  const bytes = Buffer.from([
    0x42, 0x6c, 0xe5, 0x62, 0xe6, 0x72, 0x20, 0x96, 0x20, 0x80, 0x35, 0x0a,
  ]);
  const file = fixture(t, bytes);
  const { result } = await readTextFile(file);
  assert.equal(result.encoding, "Windows-1252");
  assert.equal(result.text, "Blåbær – €5\n");
  assert.equal(result.eol, "LF");
  await writeTextFile(file, result.text, { encoding: result.encoding, eol: result.eol });
  assert.deepEqual(fs.readFileSync(file), bytes);
  await assert.rejects(
    writeTextFile(file, "emoji 👋", { encoding: "Windows-1252", eol: "LF" }),
    /cannot hold/,
  );
  assert.deepEqual(fs.readFileSync(file), bytes, "a failed write leaves the file alone");
});

test("UTF-8 is only chosen when every byte is valid", () => {
  const valid = Buffer.from("x".repeat(70000) + "æ");
  assert.equal(detectEncoding(valid.subarray(0, 4), valid), "UTF-8");
  // "…bær" in Windows-1252 at the very end of a file: not UTF-8.
  const late = Buffer.concat([Buffer.from("x".repeat(70000)), Buffer.from([0xe6])]);
  assert.equal(detectEncoding(late.subarray(0, 4), late), "Windows-1252");
  // A sample cut in the middle of a character is still UTF-8.
  const cut = Buffer.from("æ").subarray(0, 1);
  assert.equal(detectEncoding(cut, cut, { cut: true }), "UTF-8");
});

test("line endings are detected by majority", () => {
  assert.equal(detectEol("a\r\nb\r\nc\n"), "CRLF");
  assert.equal(detectEol("a\nb\nc\r\n"), "LF");
  assert.equal(detectEol("a\rb\rc\n"), "CR");
  assert.equal(detectEol("one line"), process.platform === "win32" ? "CRLF" : "LF");
});

test("write normalises newlines to the requested ending", async (t) => {
  const file = fixture(t, "a\nb\n");
  await writeTextFile(file, "x\ny\r\nz\rw", { encoding: "UTF-8", eol: "CRLF" });
  assert.equal(fs.readFileSync(file, "utf8"), "x\r\ny\r\nz\r\nw");
  await writeTextFile(file, "x\r\ny\n", { encoding: "utf8", eol: "LF" });
  assert.equal(fs.readFileSync(file, "utf8"), "x\ny\n");
  await writeTextFile(file, "x\ny\n", { encoding: "UTF-8", eol: "CR" });
  assert.equal(fs.readFileSync(file, "utf8"), "x\ry\r");
});

test("write creates a new file and leaves no temp files behind", async (t) => {
  const directory = dir(t);
  const file = path.join(directory, "new.md");
  const written = await writeTextFile(file, "# Hi\n", { encoding: "UTF-8 BOM", eol: "LF" });
  assert.deepEqual(fs.readFileSync(file), Buffer.concat([BOM8, Buffer.from("# Hi\n")]));
  assert.equal(written.size, 8);
  assert.deepEqual(fs.readdirSync(directory), ["new.md"]);
});

test("a failed write keeps the original and cleans up", async (t) => {
  const file = fixture(t, "original\n");
  const directory = path.dirname(file);
  const fsp = require("node:fs/promises");
  const rename = fsp.rename;
  fsp.rename = async () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  try {
    await assert.rejects(
      writeTextFile(file, "new\n", { encoding: "UTF-8", eol: "LF" }),
      /disk full/,
    );
  } finally {
    fsp.rename = rename;
  }
  assert.equal(fs.readFileSync(file, "utf8"), "original\n");
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test("read-only files are reported and not written", async (t) => {
  const file = fixture(t, "locked\n");
  fs.chmodSync(file, 0o444);
  try {
    const { result } = await readTextFile(file);
    assert.equal(result.readOnly, true);
    await assert.rejects(writeTextFile(file, "x", { encoding: "UTF-8", eol: "LF" }), /read-only/);
    assert.equal(fs.readFileSync(file, "utf8"), "locked\n");
  } finally {
    fs.chmodSync(file, 0o666);
  }
});

test("files over 50 MB return their last lines, read-only", async (t) => {
  const file = path.join(dir(t), "huge.log");
  const line = "2026-11-01T10:00:00Z INFO the quick brown fox jumps over the lazy dog\r\n";
  const handle = fs.openSync(file, "w");
  const block = Buffer.from(line.repeat(Math.ceil((1024 * 1024) / line.length)));
  let size = 0;
  while (size <= LARGE_FILE_BYTES) {
    fs.writeSync(handle, block);
    size += block.length;
  }
  fs.writeSync(handle, Buffer.from("LAST LINE\r\n"));
  fs.closeSync(handle);
  const { result } = await readTextFile(file);
  assert.equal(result.truncated, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.size, fs.statSync(file).size);
  assert.ok(result.text.length < 6 * 1024 * 1024);
  assert.ok(result.text.startsWith("2026-11-01T10:00:00Z INFO"), "starts on a line boundary");
  assert.ok(result.text.endsWith("LAST LINE\n"));
  assert.equal(result.eol, "CRLF");
  await assert.rejects(writeTextFile(file, "x", { encoding: "UTF-8", eol: "LF" }), /large file/);
});

test("binary files are refused", async (t) => {
  const file = fixture(t, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]), "image.dat");
  await assert.rejects(readTextFile(file), /binary/);
  assert.equal(await isTextLikeFile(file), false);
});

test("text-like files are recognised by extension or content", async (t) => {
  assert.equal(await isTextLikeFile(fixture(t, "{}", "a.json")), true);
  assert.equal(await isTextLikeFile(fixture(t, "plain words", "notes.unknownext")), true);
  assert.equal(await isTextLikeFile(fixture(t, "not really", "photo.png")), false);
  assert.equal(await isTextLikeFile(fixture(t, "FROM node", "Dockerfile")), true);
  assert.equal(await isTextLikeFile(path.join(os.tmpdir(), "does-not-exist.txt")), false);
});

test("encoding labels accept common spellings", () => {
  assert.equal(normalizeEncoding("utf-8"), "UTF-8");
  assert.equal(normalizeEncoding("UTF-16LE"), "UTF-16 LE");
  assert.equal(normalizeEncoding("cp1252"), "Windows-1252");
  assert.throws(() => normalizeEncoding("shift_jis"), /cannot write/);
  assert.deepEqual(
    encodeText("a\nb", "UTF-16 BE", "LF"),
    Buffer.from([0xfe, 0xff, 0, 0x61, 0, 0x0a, 0, 0x62]),
  );
});

test("fileArguments keeps only file paths", () => {
  const cwd = path.resolve("/work");
  assert.deepEqual(
    fileArguments(["joty.exe", "--flag", "notes.md", "joty://note/1", "C:\\x\\y.txt"], cwd),
    [path.resolve(cwd, "notes.md"), path.resolve(cwd, "C:\\x\\y.txt")],
  );
  assert.deepEqual(fileArguments(["electron.exe", ".", "a.txt"], cwd, true), [
    path.resolve(cwd, "a.txt"),
  ]);
});
