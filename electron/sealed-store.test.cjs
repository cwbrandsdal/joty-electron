const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSealedStore } = require("./sealed-store.cjs");

function fakeSafeStorage({ available = true } = {}) {
  return {
    available,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString("base64")}`),
    decryptString: (b) => {
      const text = b.toString();
      if (!text.startsWith("enc:")) throw new Error("Error while decrypting the ciphertext");
      return Buffer.from(text.slice(4), "base64").toString();
    },
  };
}

function setup(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "joty-sealed-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "joty-sealed.bin");
  const safeStorage = fakeSafeStorage(options);
  return { directory, file, safeStorage, store: createSealedStore({ file, safeStorage }) };
}

test("sealed payloads are encrypted at rest and read back", async (t) => {
  const { file, store, directory } = setup(t);
  assert.equal(await store.read(), null);
  await store.write('[{"id":"s1","text":"secret æøå"}]');
  assert.ok(!fs.readFileSync(file).toString().includes("secret"));
  assert.equal(await store.read(), '[{"id":"s1","text":"secret æøå"}]');
  await store.write("[]");
  assert.equal(await store.read(), "[]");
  assert.ok(fs.existsSync(`${file}.bak`), "the previous generation is kept");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["joty-sealed.bin", "joty-sealed.bin.bak"]);
});

test("concurrent writes are serialized; the last one wins", async (t) => {
  const { store } = setup(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.write(`v${i}`)));
  assert.equal(await store.read(), "v9");
});

test("without OS encryption, sealed data is refused, never written in plaintext", async (t) => {
  const { file, store, safeStorage } = setup(t);
  await store.write("kept");
  safeStorage.available = false;
  await assert.rejects(store.write("leak"), /encryption is not available/);
  await assert.rejects(store.read(), /encryption is not available/);
  safeStorage.available = true;
  assert.equal(await store.read(), "kept");
  assert.ok(!fs.readFileSync(file).toString().includes("leak"));
});

test("unreadable ciphertext fails the read and is left in place", async (t) => {
  const { file, store } = setup(t);
  fs.writeFileSync(file, "garbage");
  await assert.rejects(store.read(), /decrypting/);
  assert.equal(fs.readFileSync(file, "utf8"), "garbage");
  await assert.rejects(store.write(42), /must be text/);
});
