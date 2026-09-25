const { safeStorage, powerMonitor } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

// Desktop authentication lives in the main process.
//
// The renderer never sees WorkOS tokens. This module runs the AuthKit PKCE
// sign-in (the hosted page loads in the app window and redirects to a
// loopback listener that only exists during sign-in), keeps the refresh token
// encrypted at rest with the OS keychain (DPAPI on Windows), and refreshes the
// access token proactively — including while the window is hidden and after
// the machine wakes from sleep.
//
// Failure policy follows WorkOS's session-resilience guidance: only a
// terminal `invalid_grant` ends the session. Network errors, timeouts, 5xx and
// 429 keep the session and retry with backoff. Retries start quickly (1s/3s/8s)
// so a refresh whose response was lost is replayed inside WorkOS's 30-second
// grace window, where the old token still returns the rotated pair.

const WORKOS_API = "https://api.workos.com";
const REFRESH_BUFFER_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 30_000, 60_000, 120_000, 300_000, 600_000];
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const ENCRYPTED_FILE = "joty-auth.bin";
const PLAINTEXT_FILE = "joty-auth.json";

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = String(token).split(".");
    return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : null;
  } catch {
    return null;
  }
}

function normalizeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//"))
    return "/notes";
  const pathOnly = value.split(/[?#]/)[0];
  return pathOnly === "/notes" || pathOnly.startsWith("/notes/") ? value : "/notes";
}

function mapUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    profilePictureUrl: user.profile_picture_url ?? null,
  };
}

function htmlPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f8f5f0;color:#1f1d1a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#6b6560}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

class AuthManager {
  /**
   * @param {object} options
   * @param {string} options.clientId WorkOS client id
   * @param {number} options.callbackPort loopback port registered as the redirect URI
   * @param {string} options.userDataPath directory for the encrypted session file
   * @param {(url: string) => void} options.openAuthUrl navigate the app window to the hosted sign-in
   * @param {(returnTo: string) => void} options.onSignInFinished bring the app back after the flow (success or failure)
   * @param {(state: object) => void} options.onStateChange broadcast auth state to renderers
   * @param {{ log: Function, warn: Function, error: Function }} [options.logger]
   */
  constructor(options) {
    this.clientId = options.clientId;
    this.callbackPort = options.callbackPort;
    this.redirectUri = `http://127.0.0.1:${options.callbackPort}/auth/callback`;
    this.userDataPath = options.userDataPath;
    this.openAuthUrl = options.openAuthUrl;
    this.onSignInFinished = options.onSignInFinished;
    this.onStateChange = options.onStateChange;
    this.logger = options.logger ?? console;

    this.session = null;
    this.state = { status: "signed-out", user: null, error: null };
    this.refreshPromise = null;
    this.retryTimer = null;
    this.retryIndex = 0;
    this.proactiveTimer = null;
    this.pending = null;
  }

  // --- Lifecycle ---

  initialize() {
    this.session = this.loadSession();
    if (this.session) {
      this.state = { status: "signed-in", user: mapUser(this.session.user), error: null };
      this.scheduleProactiveRefresh();
      if (this.accessTokenExpiresSoon()) void this.refresh();
    } else if (!this.clientId) {
      this.state = {
        status: "signed-out",
        user: null,
        error: "This build has no WorkOS client id configured; sign-in is unavailable.",
      };
    }

    powerMonitor.on("resume", () => this.onResume());
    powerMonitor.on("unlock-screen", () => this.onResume());
  }

  getState() {
    return this.state;
  }

  /** Called when the window is shown/focused or the OS wakes up. */
  onResume() {
    if (!this.session) return;
    this.retryIndex = 0;
    if (this.accessTokenExpiresSoon(2 * 60_000)) void this.refresh();
  }

  // --- Tokens ---

  accessTokenExpiresSoon(buffer = REFRESH_BUFFER_MS) {
    return !this.session || this.session.accessTokenExpiresAt - buffer <= Date.now();
  }

  /**
   * @returns {Promise<{ token: string | null, transient?: boolean }>}
   * `token` is null when signed out. `transient` is true when the session is
   * intact but no valid token is available right now (offline / WorkOS down).
   */
  async getAccessToken() {
    if (!this.session) return { token: null };
    if (!this.accessTokenExpiresSoon()) return { token: this.session.accessToken };

    const result = await this.refresh();
    if (result.ok) return { token: this.session.accessToken };
    if (result.terminal || !this.session) return { token: null };
    // Transient failure: hand out the stale token if it's still technically
    // valid (the API allows some clock skew); otherwise say so.
    if (this.session.accessTokenExpiresAt > Date.now()) return { token: this.session.accessToken };
    return { token: null, transient: true };
  }

  refresh() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async doRefresh() {
    const session = this.session;
    if (!session) return { ok: false, terminal: true };
    this.clearRetry();

    let response;
    try {
      response = await fetch(`${WORKOS_API}/user_management/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: this.clientId,
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
          ...(session.organizationId ? { organization_id: session.organizationId } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return this.transientFailure(`network (${error?.name ?? "error"})`);
    }

    // The session may have been signed out while the request was in flight.
    if (this.session !== session) return { ok: false, terminal: true };

    if (response.ok) {
      let data;
      try {
        data = await response.json();
      } catch (error) {
        return this.transientFailure(`malformed response (${error?.message ?? "json"})`);
      }
      this.applyAuthResponse(data);
      return { ok: true };
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body: treated as transient below.
    }
    const code = body?.error;
    if (response.status === 400 && code === "invalid_grant") {
      this.logger.warn("[auth] refresh rejected (invalid_grant); session ended");
      this.terminate(body?.error_description || "Your session has ended. Please sign in again.");
      return { ok: false, terminal: true };
    }
    return this.transientFailure(`WorkOS ${response.status}${code ? ` ${code}` : ""}`);
  }

  transientFailure(reason) {
    const delay = RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)];
    this.retryIndex++;
    this.logger.warn(`[auth] refresh failed transiently: ${reason}; retrying in ${delay / 1000}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, delay);
    this.retryTimer.unref?.();
    return { ok: false, terminal: false };
  }

  applyAuthResponse(data) {
    const claims = decodeJwtPayload(data.access_token) ?? {};
    const lifetimeMs =
      typeof claims.exp === "number" && typeof claims.iat === "number"
        ? (claims.exp - claims.iat) * 1000
        : 5 * 60_000;
    this.session = {
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      accessTokenExpiresAt: Date.now() + lifetimeMs,
      user: data.user ?? this.session?.user ?? null,
      organizationId: data.organization_id ?? claims.org_id ?? null,
      sessionId: claims.sid ?? this.session?.sessionId ?? null,
    };
    this.retryIndex = 0;
    this.saveSession();
    this.setState({ status: "signed-in", user: mapUser(this.session.user), error: null });
    this.scheduleProactiveRefresh();
  }

  scheduleProactiveRefresh() {
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    if (!this.session) return;
    const delay = Math.max(
      5_000,
      this.session.accessTokenExpiresAt - REFRESH_BUFFER_MS - Date.now(),
    );
    this.proactiveTimer = setTimeout(() => {
      this.proactiveTimer = null;
      void this.refresh();
    }, delay);
    this.proactiveTimer.unref?.();
  }

  clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  terminate(message) {
    this.session = null;
    this.clearRetry();
    if (this.proactiveTimer) {
      clearTimeout(this.proactiveTimer);
      this.proactiveTimer = null;
    }
    this.deleteSessionFiles();
    this.setState({ status: "signed-out", user: null, error: message ?? null });
  }

  // --- Sign in / out ---

  async signIn(returnTo) {
    if (!this.clientId) {
      this.setState({
        error: "This build has no WorkOS client id configured; sign-in is unavailable.",
      });
      return;
    }
    this.cancelPendingSignIn();

    let server;
    try {
      server = await this.startCallbackServer();
    } catch (error) {
      this.setState({
        error: `Couldn't start the sign-in listener on port ${this.callbackPort} (${error?.message ?? error}).`,
      });
      return;
    }

    const codeVerifier = base64url(crypto.randomBytes(48));
    const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
    const state = base64url(crypto.randomBytes(24));
    this.pending = {
      state,
      codeVerifier,
      returnTo: normalizeReturnTo(returnTo),
      server,
      timeout: setTimeout(() => {
        this.cancelPendingSignIn();
        this.setState({ error: "Sign-in timed out. Please try again." });
        this.onSignInFinished("/");
      }, SIGN_IN_TIMEOUT_MS),
    };

    const url = new URL(`${WORKOS_API}/user_management/authorize`);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("provider", "authkit");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    this.setState({ error: null });
    this.openAuthUrl(url.toString());
  }

  async signOut() {
    const session = this.session;
    // Drop the local session first so nothing can refresh it while we tell
    // WorkOS; the remote logout is best-effort.
    this.terminate(null);
    if (!session?.sessionId) return;
    try {
      const url = new URL(`${WORKOS_API}/user_management/sessions/logout`);
      url.searchParams.set("session_id", session.sessionId);
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      this.logger.warn(
        `[auth] remote logout failed (${error?.name ?? "error"}); local session cleared`,
      );
    }
  }

  startCallbackServer() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handleCallback(req, res));
      server.on("error", reject);
      server.listen(this.callbackPort, "127.0.0.1", () => resolve(server));
    });
  }

  cancelPendingSignIn() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timeout);
    pending.server.close();
  }

  async handleCallback(req, res) {
    const url = new URL(req.url || "/", `http://127.0.0.1:${this.callbackPort}`);
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404);
      res.end();
      return;
    }

    const respond = (title, message) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(htmlPage(title, message));
    };

    const pending = this.pending;
    const state = url.searchParams.get("state");
    if (!pending || !state || state !== pending.state) {
      respond("Sign-in could not be verified", "Please return to Joty and try again.");
      return;
    }

    const code = url.searchParams.get("code");
    const errorParam = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    if (errorParam || !code) {
      const message = errorDescription || errorParam || "Sign-in did not complete.";
      respond("Sign-in did not complete", message);
      this.cancelPendingSignIn();
      this.setState({ error: message });
      this.onSignInFinished("/");
      return;
    }

    let outcome;
    try {
      outcome = await this.exchangeCode(code, pending.codeVerifier);
    } catch (error) {
      outcome = {
        ok: false,
        message: `Couldn't reach the sign-in service (${error?.name ?? "error"}).`,
      };
    }
    this.cancelPendingSignIn();

    if (outcome.ok) {
      respond("Signed in", "Returning to Joty…");
      this.onSignInFinished(pending.returnTo);
    } else {
      respond("Sign-in failed", outcome.message);
      this.setState({ error: outcome.message });
      this.onSignInFinished("/");
    }
  }

  async exchangeCode(code, codeVerifier) {
    const response = await fetch(`${WORKOS_API}/user_management/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // handled below
    }
    if (!response.ok || !body?.access_token) {
      return {
        ok: false,
        message: body?.error_description || body?.message || `Sign-in failed (${response.status}).`,
      };
    }
    this.applyAuthResponse(body);
    return { ok: true };
  }

  // --- Persistence ---

  get encryptedPath() {
    return path.join(this.userDataPath, ENCRYPTED_FILE);
  }

  get plaintextPath() {
    return path.join(this.userDataPath, PLAINTEXT_FILE);
  }

  loadSession() {
    try {
      if (fs.existsSync(this.encryptedPath)) {
        if (!safeStorage.isEncryptionAvailable()) {
          this.logger.warn("[auth] OS encryption unavailable; cannot read the stored session");
          return null;
        }
        const json = safeStorage.decryptString(fs.readFileSync(this.encryptedPath));
        return this.validateSession(JSON.parse(json));
      }
      if (fs.existsSync(this.plaintextPath)) {
        return this.validateSession(JSON.parse(fs.readFileSync(this.plaintextPath, "utf8")));
      }
    } catch (error) {
      this.logger.warn(
        `[auth] stored session unreadable (${error?.message ?? error}); starting signed out`,
      );
    }
    return null;
  }

  validateSession(value) {
    if (!value || typeof value.refreshToken !== "string" || typeof value.accessToken !== "string") {
      return null;
    }
    return {
      refreshToken: value.refreshToken,
      accessToken: value.accessToken,
      accessTokenExpiresAt: Number(value.accessTokenExpiresAt) || 0,
      user: value.user ?? null,
      organizationId: value.organizationId ?? null,
      sessionId: value.sessionId ?? null,
    };
  }

  saveSession() {
    if (!this.session) return;
    const json = JSON.stringify(this.session);
    try {
      fs.mkdirSync(this.userDataPath, { recursive: true });
      if (safeStorage.isEncryptionAvailable()) {
        fs.writeFileSync(this.encryptedPath, safeStorage.encryptString(json));
        fs.rmSync(this.plaintextPath, { force: true });
      } else {
        this.logger.warn("[auth] OS encryption unavailable; storing the session unencrypted");
        fs.writeFileSync(this.plaintextPath, json, { mode: 0o600 });
      }
    } catch (error) {
      this.logger.error(`[auth] could not persist the session (${error?.message ?? error})`);
    }
  }

  deleteSessionFiles() {
    fs.rmSync(this.encryptedPath, { force: true });
    fs.rmSync(this.plaintextPath, { force: true });
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.state);
  }
}

module.exports = { AuthManager, normalizeReturnTo, decodeJwtPayload };
