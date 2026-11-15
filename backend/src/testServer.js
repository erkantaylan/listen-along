// Helpers for tests that spawn the real server (src/index.js) as a child
// process. Not a test file itself (the name matches none of node --test's
// patterns).
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DEV_COOKIE, signDevToken, adminAuth } = require('./auth/index.ts');

const SECRET = 'test-session-secret';
const ADMIN_PASSWORD = 'test-admin-pw';
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

/**
 * A dev sign-in cookie (`la_dev_login`, auth/devLogin.ts) for users.id `userId`.
 * startServer() turns the dev sign-in on unless the test configures central
 * login, so this is the login of every server a test starts without OIDC_*.
 */
function cookieFor(userId, t = Date.now(), secret = SECRET) {
  return `${DEV_COOKIE}=${signDevToken(secret, userId, t)}`;
}

/** A valid la_admin cookie for ADMIN_PASSWORD. */
function adminCookie(password = ADMIN_PASSWORD) {
  const prev = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = password;
  const v = `la_admin=${encodeURIComponent(adminAuth.createSessionValue())}`;
  if (prev === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prev;
  return v;
}

/**
 * A port that was free a moment ago. Only for something that must know a
 * port before anything listens on it (a dead address, a BASE_URL): another
 * process can take it in between. A server a test starts binds port 0
 * itself and says which port it got (listening()).
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

/**
 * Resolves with the port once a spawned src/index.js says it listens
 * ("Server running on port N", the port it actually bound); rejects with its
 * output when it exits first, cannot bind (EADDRINUSE: index.js logs an
 * uncaught exception and stays up, not listening) or takes longer than
 * `timeoutMs`.
 * @param {import('node:child_process').ChildProcess} proc
 * @returns {Promise<number>}
 */
function listening(proc, timeoutMs = 30_000) {
  let log = '';
  return new Promise((resolve, reject) => {
    const fail = (message) => { clearTimeout(timer); reject(Object.assign(new Error(`${message}\n${log}`), { log })); };
    const timer = setTimeout(() => fail('server did not start'), timeoutMs);
    const onData = (d) => {
      log += d;
      const m = /Server running on port (\d+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); } else if (/EADDRINUSE/.test(log)) fail('server could not bind its port');
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => { clearTimeout(timer); reject(Object.assign(new Error(`server exited (${code})\n${log}`), { exitCode: code, log })); });
  });
}

/**
 * The central login's counterpart of cookieFor: a server-side session for
 * users.id `userId`, inserted straight into `user_sessions` (no IdP round
 * trip; no refresh token, so it is never re-checked and lasts until
 * OIDC_MAX_UNVERIFIED_SECONDS, 24 h by default). `pg` is a connected pg Client
 * or a connection string. Returns the `la_session=...` cookie.
 */
async function centralSessionCookie(pg, userId, { sub = `dev-${userId}`, now = Date.now() } = {}) {
  let client = pg;
  if (typeof pg === 'string') {
    const { Client } = require('pg');
    client = new Client({ connectionString: pg });
    await client.connect();
  }
  try {
    const raw = crypto.randomBytes(32).toString('base64url');
    const idHash = crypto.createHash('sha256').update(raw).digest('hex');
    await client.query(
      `INSERT INTO user_sessions (id_hash, user_id, oidc_sub, created_at, last_checked_at, expires_at)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [idHash, userId, sub, now, now + 30 * 24 * 60 * 60 * 1000]
    );
    return `la_session=${raw}`;
  } finally {
    if (client !== pg) await client.end();
  }
}

/**
 * Start src/index.js; resolves once it listens. DATABASE_URL only if given.
 * `extraEnv` may be a function of the port (for BASE_URL in central-login tests).
 * The dev sign-in (INSECURE_DEV_LOGIN, cookieFor) is on unless `extraEnv` sets
 * OIDC_ISSUER or OIDC_CLIENT_ID: the server allows one or the other.
 * @param {Record<string, string> | ((port: number) => Record<string, string>)} [extraEnvOrFn]
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, base: string, port: number, stop: () => Promise<void>, log: () => string }>}
 */
async function startServer(extraEnvOrFn = {}) {
  // The server binds port 0 and reports its port, unless the env needs the port
  // first (a function of it): then a free one is picked, and picked again in
  // the rare case another process took it before the server bound it.
  const portFirst = typeof extraEnvOrFn === 'function';
  for (let attempt = 1; ; attempt++) {
    const chosen = portFirst ? await freePort() : 0;
    try {
      return await spawnServer(chosen, portFirst ? extraEnvOrFn(chosen) : extraEnvOrFn);
    } catch (err) {
      if (!(portFirst && attempt < 5 && /EADDRINUSE/.test(err.log || ''))) throw err;
    }
  }
}

async function spawnServer(chosenPort, extraEnv) {
  const env = {
    ...process.env, PORT: String(chosenPort), SESSION_SECRET: SECRET, NODE_ENV: 'test', ADMIN_PASSWORD,
    PRESENCE_GRACE_MS: '0', FRONTEND_PATH: FRONTEND,
    COVERS_DIR: path.join(os.tmpdir(), 'la-test-covers'),
    INSECURE_DEV_LOGIN: extraEnv.OIDC_ISSUER || extraEnv.OIDC_CLIENT_ID ? '' : '1', ...extraEnv,
  };
  if (!extraEnv.DATABASE_URL) delete env.DATABASE_URL;
  const proc = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  proc.stdout.on('data', (d) => { log += d; });
  let port;
  try {
    port = await listening(proc);
  } catch (err) {
    proc.kill('SIGKILL');
    throw err;
  }
  const stop = () => new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL');
  });
  return { proc, base: `http://127.0.0.1:${port}`, port, stop, log: () => log };
}

/**
 * JSON request helper: req(method, url, { cookie, headers, body }).
 * @param {string} base
 * @returns {(method: string, url: string, opts?: { cookie?: string, headers?: Record<string, string>, body?: unknown }) =>
 *   Promise<{ status: number, body: any, text: string, headers: Headers }>}
 */
function requester(base) {
  return async function req(method, url, { cookie, headers = {}, body } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  };
}

module.exports = { SECRET, ADMIN_PASSWORD, cookieFor, centralSessionCookie, adminCookie, freePort, listening, startServer, requester };
