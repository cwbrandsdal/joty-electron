// Sealed sheets: one payload encrypted with the OS key store (Electron
// safeStorage, DPAPI on Windows) in userData/joty-sealed.bin. Fails closed:
// no plaintext fallback, and unreadable ciphertext is never overwritten by
// a read failure. Writes are atomic and serialized; the previous file is
// kept as joty-sealed.bin.bak.
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_PAYLOAD_CHARS = 64 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSealedStore({ file, safeStorage }) {
  let tail = Promise.resolve();

  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Windows encryption is not available, so sealed sheets cannot be opened or saved.",
      );
    }
  }

  async function read() {
    let bytes;
    try {
      bytes = await fsp.readFile(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    requireEncryption();
    return safeStorage.decryptString(bytes);
  }

  function write(payload) {
    if (typeof payload !== "string") return Promise.reject(new Error("Sealed data must be text."));
    if (payload.length > MAX_PAYLOAD_CHARS) {
      return Promise.reject(new Error("Sealed sheets are limited to 64 MB."));
    }
    const operation = tail.then(async () => {
      requireEncryption();
      const bytes = safeStorage.encryptString(payload);
      const dir = path.dirname(file);
      await fsp.mkdir(dir, { recursive: true });
      const temporary = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fsp.open(temporary, "wx", 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fsp.copyFile(file, `${file}.bak`).catch(() => {});
        for (let attempt = 0; ; attempt++) {
          try {
            await fsp.rename(temporary, file);
            break;
          } catch (error) {
            if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 5) throw error;
            await sleep(50 * (attempt + 1));
          }
        }
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fsp.rm(temporary, { force: true }).catch(() => {});
      }
    });
    tail = operation.catch(() => {});
    return operation;
  }

  return { read, write };
}

module.exports = { createSealedStore };
