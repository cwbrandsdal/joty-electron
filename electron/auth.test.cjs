// Unit tests for the main-process auth manager with WorkOS and Electron
// mocked. Run with `npm test` (node --test).
const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Stand in for the `electron` module before auth.cjs requires it.
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc:${s}`),
      decryptString: (b) => b.toString().replace(/^enc:/, ""),
    },
    powerMonitor: { on() {} },
  },
};
const { AuthManager, normalizeReturnTo } = require("./auth.cjs");

function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

function tokenResponse({ refresh = "rt-2", lifetime = 300 } = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return {
    access_token: jwt({ iat, exp: iat + lifetime, sid: "sess_1", sub: "user_1" }),
    refresh_token: refresh,
    user: { id: "user_1", email: "c@example.com", first_name: "C" },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

let tmp;
let states;
let manager;
const silent = { log() {}, info() {}, warn() {}, error() {} };

function createManager() {
  states = [];
  return new AuthManager({
    clientId: "client_test",
    callbackPort: 39179,
    userDataPath: tmp,
    openAuthUrl: () => {},
    onSignInFinished: () => {},
    onStateChange: (s) => states.push(s),
    logger: silent,
  });
}

function seedSession(overrides = {}) {
  fs.writeFileSync(
    path.join(tmp, "joty-auth.bin"),
    Buffer.from(
      "enc:" +
        JSON.stringify({
          refreshToken: "rt-1",
          accessToken: jwt({ iat: 1, exp: 2, sid: "sess_1" }),
          accessTokenExpiresAt: Date.now() - 60_000, // already expired
          user: { id: "user_1", email: "c@example.com" },
          organizationId: null,
          sessionId: "sess_1",
          ...overrides,
        }),
    ),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joty-auth-test-"));
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("normalizeReturnTo only allows /notes routes", () => {
  assert.equal(normalizeReturnTo("/notes/abc?x=1"), "/notes/abc?x=1");
  assert.equal(normalizeReturnTo("/settings"), "/notes");
  assert.equal(normalizeReturnTo("https://evil.example/notes"), "/notes");
  assert.equal(normalizeReturnTo("//evil.example/notes"), "/notes");
  assert.equal(normalizeReturnTo(undefined), "/notes");
});

test("a stored session restores as signed-in without any network call", () => {
  seedSession({ accessTokenExpiresAt: Date.now() + 10 * 60_000 });
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("must not be called");
  });
  manager = createManager();
  manager.initialize();

  assert.equal(manager.getState().status, "signed-in");
  assert.equal(manager.getState().user.email, "c@example.com");
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("getAccessToken returns the cached token while it is fresh", async () => {
  seedSession({ accessTokenExpiresAt: Date.now() + 10 * 60_000 });
  mock.method(globalThis, "fetch", async () => {
    throw new Error("must not be called");
  });
  manager = createManager();
  manager.initialize();

  const result = await manager.getAccessToken();
  assert.ok(result.token);
});

test("an expired token is refreshed, rotated, and persisted", async () => {
  seedSession();
  const calls = [];
  mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse(200, tokenResponse({ refresh: "rt-2" }));
  });
  manager = createManager();
  manager.initialize();
  await manager.refresh(); // initialize() kicked one off; wait for it

  const result = await manager.getAccessToken();
  assert.ok(result.token);
  assert.equal(calls[0].grant_type, "refresh_token");
  assert.equal(calls[0].refresh_token, "rt-1");
  assert.equal(manager.session.refreshToken, "rt-2");

  const stored = JSON.parse(
    fs.readFileSync(path.join(tmp, "joty-auth.bin")).toString().replace(/^enc:/, ""),
  );
  assert.equal(stored.refreshToken, "rt-2");
});

test("invalid_grant is terminal: session cleared, file removed, signed-out with a message", async () => {
  seedSession();
  mock.method(globalThis, "fetch", async () =>
    jsonResponse(400, { error: "invalid_grant", error_description: "Session has expired." }),
  );
  manager = createManager();
  manager.initialize();
  await manager.refresh();

  assert.equal(manager.getState().status, "signed-out");
  assert.equal(manager.getState().error, "Session has expired.");
  assert.equal(manager.session, null);
  assert.equal(fs.existsSync(path.join(tmp, "joty-auth.bin")), false);
  assert.deepEqual(await manager.getAccessToken(), { token: null });
});

test("network errors and 5xx are transient: session kept, retried with backoff", async () => {
  seedSession();
  let attempt = 0;
  mock.method(globalThis, "fetch", async () => {
    attempt++;
    if (attempt === 1) throw new TypeError("fetch failed");
    if (attempt === 2) return jsonResponse(503, { error: "server_error" });
    return jsonResponse(200, tokenResponse());
  });
  manager = createManager();
  manager.initialize();
  await manager.refresh();

  assert.equal(manager.getState().status, "signed-in");
  assert.equal(manager.session.refreshToken, "rt-1");
  // No usable token right now, but the session is intact.
  assert.deepEqual(await manager.getAccessToken(), { token: null, transient: true });

  mock.timers.tick(1_000); // first retry (503)
  await Promise.resolve();
  await manager.refresh();
  assert.equal(manager.getState().status, "signed-in");

  mock.timers.tick(3_000); // second retry succeeds
  await Promise.resolve();
  await manager.refresh();
  assert.equal(attempt >= 3, true);
  assert.equal(manager.session.refreshToken, "rt-2");
  assert.ok((await manager.getAccessToken()).token);
});

test("429 keeps the session too", async () => {
  seedSession();
  mock.method(globalThis, "fetch", async () => jsonResponse(429, { error: "rate_limited" }));
  manager = createManager();
  manager.initialize();
  await manager.refresh();

  assert.equal(manager.getState().status, "signed-in");
  assert.equal(manager.session.refreshToken, "rt-1");
});

test("signOut clears the session and calls the WorkOS logout endpoint best-effort", async () => {
  seedSession({ accessTokenExpiresAt: Date.now() + 10 * 60_000 });
  const urls = [];
  mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) };
  });
  manager = createManager();
  manager.initialize();

  await manager.signOut();

  assert.equal(manager.getState().status, "signed-out");
  assert.equal(manager.getState().error, null);
  assert.ok(urls[0].includes("/user_management/sessions/logout"));
  assert.ok(urls[0].includes("session_id=sess_1"));
  assert.equal(fs.existsSync(path.join(tmp, "joty-auth.bin")), false);
});
