const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  MAX_CLEAR_MS,
  MIN_CLEAR_MS,
  copyScript,
  createSecretClipboard,
} = require("./secret-clipboard.cjs");

const SECRET = ["Tr0ub4dor", "n0t", "real"].join("-");

/** A clipboard double with Electron's readText/writeText/clear. */
function fakeClipboard(initial = "") {
  const board = {
    text: initial,
    writes: 0,
    clears: 0,
    readText: () => board.text,
    writeText: (text) => {
      board.text = text;
      board.writes++;
    },
    clear: () => {
      board.text = "";
      board.clears++;
    },
  };
  return board;
}

/** Timers run by hand: fire() runs everything due. */
function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    get scheduled() {
      return [...timers.values()].map((t) => t.ms);
    },
    fire() {
      for (const [id, t] of [...timers]) {
        timers.delete(id);
        t.fn();
      }
    },
  };
}

function setup({ privateCopy, initial } = {}) {
  const clipboard = fakeClipboard(initial);
  const timers = fakeTimers();
  const warnings = [];
  const copier =
    privateCopy === undefined
      ? async (text) => {
          clipboard.text = text; // what the hidden page's copy does
          return true;
        }
      : privateCopy;
  const secrets = createSecretClipboard({
    clipboard,
    privateCopy: copier,
    log: { warn: (line) => warnings.push(line) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { clipboard, timers, warnings, secrets };
}

test("copies through the private page and clears after the delay when unchanged", async () => {
  const { clipboard, timers, warnings, secrets } = setup({ initial: "before" });
  const result = await secrets.writeSecret(SECRET, 30000);
  assert.deepEqual(result, { historyExcluded: true, clearAfterMs: 30000 });
  assert.equal(clipboard.text, SECRET);
  assert.equal(clipboard.writes, 0, "no plain writeText when the private copy worked");
  assert.deepEqual(timers.scheduled, [30000]);
  assert.equal(secrets.pending, true);
  timers.fire();
  assert.equal(clipboard.text, "");
  assert.equal(clipboard.clears, 1);
  assert.equal(secrets.pending, false);
  assert.deepEqual(warnings, []);
});

test("leaves the clipboard alone when something else was copied since", async () => {
  const { clipboard, timers, secrets } = setup();
  await secrets.writeSecret(SECRET, 30000);
  clipboard.text = "copied later by the person";
  timers.fire();
  assert.equal(clipboard.text, "copied later by the person");
  assert.equal(clipboard.clears, 0);
  // An image (no text) on the clipboard is left alone too.
  await secrets.writeSecret(SECRET, 30000);
  clipboard.text = "";
  timers.fire();
  assert.equal(clipboard.clears, 0);
});

test("compares line endings loosely (Windows may hand back CRLF)", async () => {
  const { clipboard, timers, secrets } = setup();
  await secrets.writeSecret("line one\nline two", 5000);
  clipboard.text = "line one\r\nline two";
  timers.fire();
  assert.equal(clipboard.clears, 1);
});

test("falls back to writeText when the private copy fails, and still clears", async () => {
  for (const privateCopy of [
    async () => false,
    async () => {
      throw new Error("The clipboard page timed out");
    },
    async () => true, // claims success but the clipboard does not hold the text
  ]) {
    const { clipboard, timers, warnings, secrets } = setup({ privateCopy, initial: "x" });
    const result = await secrets.writeSecret(SECRET, 30000);
    assert.equal(result.historyExcluded, false);
    assert.equal(clipboard.text, SECRET);
    assert.equal(clipboard.writes, 1);
    assert.ok(warnings.some((w) => /without clipboard-history exclusion/.test(w)));
    assert.ok(
      warnings.every((w) => !w.includes(SECRET)),
      "the value is never logged",
    );
    timers.fire();
    assert.equal(clipboard.text, "");
  }
  // No private copier at all (not on Windows, tests): writeText, no warning.
  const clipboard = fakeClipboard();
  const timers = fakeTimers();
  const warnings = [];
  const secrets = createSecretClipboard({
    clipboard,
    log: { warn: (line) => warnings.push(line) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  assert.equal((await secrets.writeSecret(SECRET, 1000)).historyExcluded, false);
  assert.equal(clipboard.text, SECRET);
  assert.deepEqual(warnings, []);
});

test("a newer secret takes over the pending clear", async () => {
  const { clipboard, timers, secrets } = setup();
  await secrets.writeSecret("first-S3cret-value", 30000);
  await secrets.writeSecret(SECRET, 10000);
  assert.deepEqual(timers.scheduled, [10000]);
  timers.fire();
  assert.equal(clipboard.text, "");
  assert.equal(clipboard.clears, 1);
});

test("flush at quit clears now, only if the secret is still there", async () => {
  const { clipboard, timers, secrets } = setup();
  await secrets.writeSecret(SECRET, 30000);
  assert.equal(secrets.flush(), true);
  assert.equal(clipboard.text, "");
  assert.deepEqual(timers.scheduled, []);
  assert.equal(secrets.flush(), false);

  await secrets.writeSecret(SECRET, 30000);
  clipboard.text = "something else";
  assert.equal(secrets.flush(), false);
  assert.equal(clipboard.text, "something else");
});

test("validates the text and clamps the delay", async () => {
  const { secrets, timers } = setup();
  await assert.rejects(secrets.writeSecret("", 1000), /Nothing to copy/);
  await assert.rejects(secrets.writeSecret(42, 1000), /Nothing to copy/);
  await assert.rejects(secrets.writeSecret("x".repeat(1024 * 1024 + 1), 1000), /too long/);
  for (const bad of [0, -5, Number.NaN, Infinity, "30000", undefined]) {
    await assert.rejects(secrets.writeSecret(SECRET, bad), /clearAfterMs/);
  }
  assert.deepEqual(timers.scheduled, [], "rejected calls schedule nothing");
  assert.equal((await secrets.writeSecret(SECRET, 10)).clearAfterMs, MIN_CLEAR_MS);
  assert.equal((await secrets.writeSecret(SECRET, 24 * 3600 * 1000)).clearAfterMs, MAX_CLEAR_MS);
  // A rejected call does not block the next one.
  assert.equal((await secrets.writeSecret(SECRET, 2500)).clearAfterMs, 2500);
});

test("the page script copies exactly the text through a copy event", () => {
  const text = 'quote " backslash \\ newline \n and </script>  ';
  let listener = null;
  const clipboardData = { data: null, setData: (type, value) => (clipboardData.data = value) };
  const document = {
    addEventListener: (type, fn) => type === "copy" && (listener = fn),
    removeEventListener: () => {},
    execCommand: (command) => {
      assert.equal(command, "copy");
      listener({ clipboardData, preventDefault: () => {} });
      return true;
    },
  };
  assert.equal(vm.runInNewContext(copyScript(text), { document }), true);
  assert.equal(clipboardData.data, text);
});
