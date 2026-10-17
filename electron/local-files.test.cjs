const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readDocument, saveDocument, fileArguments, MAX_BYTES } = require("./local-files.cjs");

function fixture(t, bytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "joty-file-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "example file.md");
  fs.writeFileSync(file, bytes);
  return file;
}

for (const encoding of ["utf8", "utf8-bom", "utf16le", "utf16be"]) {
  test(`save preserves ${encoding}, BOM, and CRLF`, (t) => {
    const encode = (text) => {
      if (encoding === "utf8") return Buffer.from(text);
      if (encoding === "utf8-bom")
        return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
      const body = Buffer.from(text, "utf16le");
      return encoding === "utf16le"
        ? Buffer.concat([Buffer.from([0xff, 0xfe]), body])
        : Buffer.concat([Buffer.from([0xfe, 0xff]), body.swap16()]);
    };
    const file = fixture(t, encode("Hei æøå 👋\r\nOriginal\r\n"));
    const doc = readDocument(file);
    assert.equal(doc.body, "Hei æøå 👋\nOriginal\n");
    doc.body += "New\n";
    saveDocument(doc);
    assert.deepEqual(fs.readFileSync(file), encode("Hei æøå 👋\r\nOriginal\r\nNew\r\n"));
    assert.equal(doc.savedBody, doc.body);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["example file.md"]);
  });
}

test("opening and saving without edits preserves mixed line endings byte-for-byte", (t) => {
  const file = fixture(t, "one\r\ntwo\nthree\r");
  const before = fs.readFileSync(file);
  saveDocument(readDocument(file));
  assert.deepEqual(fs.readFileSync(file), before);
});

test("external edits and deletion do not overwrite or lose the draft", (t) => {
  const file = fixture(t, "original");
  const doc = readDocument(file);
  doc.body = "my unsaved draft";
  fs.writeFileSync(file, "outside edit");
  assert.throws(() => saveDocument(doc), /changed outside Joty/);
  assert.equal(fs.readFileSync(file, "utf8"), "outside edit");
  assert.equal(doc.body, "my unsaved draft");
  assert.equal(doc.savedBody, "original");
  fs.unlinkSync(file);
  assert.throws(() => saveDocument(doc), /ENOENT/);
  assert.equal(fs.existsSync(file), false);
});

test("failed replacement leaves the original and removes temporary files", (t) => {
  const file = fixture(t, "original");
  const doc = readDocument(file);
  doc.body = "changed";
  t.mock.method(fs, "renameSync", () => {
    throw new Error("write denied");
  });
  assert.throws(() => saveDocument(doc), /write denied/);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.equal(doc.savedBody, "original");
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
});

test("rejects binary, invalid UTF, directories and oversized reads/writes", (t) => {
  const file = fixture(t, Buffer.from([0, 1, 2]));
  assert.throws(() => readDocument(file), /binary/);
  fs.writeFileSync(file, Buffer.from([0xff]));
  assert.throws(() => readDocument(file), /UTF-8/);
  assert.throws(() => readDocument(path.dirname(file)), /text or Markdown/);
  fs.writeFileSync(file, Buffer.alloc(MAX_BYTES + 1, 65));
  assert.throws(() => readDocument(file), /5 MB/);
  fs.writeFileSync(file, "small");
  const doc = readDocument(file);
  doc.body = "a".repeat(MAX_BYTES + 1);
  assert.throws(() => saveDocument(doc), /5 MB/);
  assert.equal(fs.readFileSync(file, "utf8"), "small");
});

test("file launch arguments distinguish source/packaged launches, switches and deep links", () => {
  const cwd = process.cwd();
  assert.deepEqual(
    fileArguments(["Joty.exe", "--flag", "joty://new", "file with spaces.txt"], cwd),
    [path.join(cwd, "file with spaces.txt")],
  );
  assert.deepEqual(fileArguments(["electron.exe", ".", "example.md"], cwd, true), [
    path.join(cwd, "example.md"),
  ]);
  assert.deepEqual(
    fileArguments(
      ["electron.exe", "--inspect=0", "--remote-debugging-port=0", "main.cjs", "example.md"],
      cwd,
      true,
    ),
    [path.join(cwd, "example.md")],
  );
});
