const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classifyChange, createFollower, MAX_APPEND_BYTES } = require("./file-follow.cjs");
const { readTextFile, writeTextFile } = require("./text-files.cjs");

test("classifyChange tells appends from rewrites", () => {
  const base = { size: 100, mtimeMs: 1, ino: 7 };
  assert.equal(classifyChange(base, null, false), "removed");
  assert.equal(classifyChange(base, { size: 150, mtimeMs: 2, ino: 7 }, true), "append");
  assert.equal(classifyChange(base, { size: 150, mtimeMs: 2, ino: 7 }, false), "replace");
  assert.equal(classifyChange(base, { size: 50, mtimeMs: 2, ino: 7 }, false), "replace");
  assert.equal(classifyChange(base, { size: 150, mtimeMs: 2, ino: 8 }, true), "replace");
  assert.equal(classifyChange(base, { size: 100, mtimeMs: 2, ino: 7 }, false), "replace");
  assert.equal(classifyChange(base, { size: 100, mtimeMs: 2, ino: 7 }, true), "touch");
  assert.equal(classifyChange(base, { size: 100, mtimeMs: 1, ino: 7 }, true), "none");
  assert.equal(
    classifyChange(base, { size: 101 + MAX_APPEND_BYTES, mtimeMs: 2, ino: 7 }, true),
    "replace",
  );
  // Filesystems without inode numbers report 0: size and content decide.
  assert.equal(
    classifyChange({ ...base, ino: 0 }, { size: 150, mtimeMs: 2, ino: 0 }, true),
    "append",
  );
});

function setup(t, initial) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "joty-follow-test-"));
  const file = path.join(directory, "app.log");
  fs.writeFileSync(file, initial);
  const events = [];
  let waiters = [];
  const follow = async () => {
    const { baseline } = await readTextFile(file);
    const follower = createFollower(file, {
      baseline,
      pollMs: 50,
      debounceMs: 10,
      onEvent: (event) => {
        events.push(event);
        waiters.forEach((w) => w());
        waiters = [];
      },
    });
    t.after(() => {
      follower.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    return follower;
  };
  const next = (count = events.length + 1) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for event ${count}`)),
        5000,
      );
      const check = () => {
        if (events.length >= count) {
          clearTimeout(timer);
          resolve(events[count - 1]);
        } else waiters.push(check);
      };
      check();
    });
  return { file, events, follow, next };
}

test("appended lines arrive as append events, decoded and normalised", async (t) => {
  const { file, follow, next } = setup(t, "first\r\n");
  await follow();
  fs.appendFileSync(file, "second æ\r\nthird\r\n");
  const event = await next();
  assert.equal(event.kind, "append");
  assert.equal(event.text, "second æ\nthird\n");
  assert.equal(event.size, fs.statSync(file).size);
});

test("a multi-byte character split across writes is not garbled", async (t) => {
  const { file, follow, next, events } = setup(t, "x\n");
  await follow();
  const bytes = Buffer.from("ø\n");
  fs.appendFileSync(file, bytes.subarray(0, 1));
  await new Promise((r) => setTimeout(r, 200));
  fs.appendFileSync(file, bytes.subarray(1));
  await next();
  const text = events.map((e) => e.text).join("");
  assert.equal(text, "ø\n");
});

test("a CRLF split across writes gives one newline", async (t) => {
  const { file, follow, next, events } = setup(t, "a\r");
  await follow();
  fs.appendFileSync(file, "\nb\r\n");
  await next();
  assert.equal(events[0].text, "b\n");
});

test("truncation and rewrites arrive as replace events", async (t) => {
  const { file, follow, next } = setup(t, "line one\nline two\n");
  await follow();
  fs.writeFileSync(file, "new\n");
  let event = await next();
  assert.equal(event.kind, "replace");
  assert.equal(event.text, "new\n");
  // Same size, different bytes.
  fs.writeFileSync(file, "old\n");
  event = await next(2);
  assert.equal(event.kind, "replace");
  assert.equal(event.text, "old\n");
});

test("rotation (rename + new file) arrives as replace", async (t) => {
  const { file, follow, next } = setup(t, "before rotation\n");
  await follow();
  fs.renameSync(file, `${file}.1`);
  fs.writeFileSync(file, "after rotation, a longer first line\n");
  let event = await next();
  // The rename may be seen first as a removal.
  if (event.kind === "removed") event = await next(2);
  assert.equal(event.kind, "replace");
  assert.equal(event.text, "after rotation, a longer first line\n");
});

test("deletion arrives as removed; recreation as replace", async (t) => {
  const { file, follow, next } = setup(t, "here\n");
  await follow();
  fs.rmSync(file);
  assert.deepEqual(await next(), { kind: "removed" });
  fs.writeFileSync(file, "back\n");
  const event = await next(2);
  assert.equal(event.kind, "replace");
  assert.equal(event.text, "back\n");
});

test("our own writes do not echo back once rebased", async (t) => {
  const { file, follow, events } = setup(t, "one\n");
  const follower = await follow();
  const written = await writeTextFile(file, "one\ntwo\n", { encoding: "UTF-8", eol: "LF" });
  follower.rebase(written.baseline);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(events, []);
  fs.appendFileSync(file, "three\n");
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(
    events.map((e) => [e.kind, e.text]),
    [["append", "three\n"]],
  );
});
