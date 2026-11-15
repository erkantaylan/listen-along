// Helpers for tests that spawn the real server (src/index.js) as a child
// process. Not a test file itself (the name matches none of node --test's
// patterns).
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DEV_COOKIE, signDevToken } = require('./devLogin');

const SECRET = 'test-session-secret';
const ADMIN_PASSWORD = 'test-admin-pw';
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

/**
 * A dev sign-in cookie (`la_dev_login`, devLogin.js) for users.id `userId`.
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
  const v = `la_admin=${encodeURIComponent(require('./adminAuth').createSessionValue())}`;
  if (prev === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prev;
  return v;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
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
 */
async function startServer(extraEnvOrFn = {}) {
  const port = await freePort();
  const extraEnv = typeof extraEnvOrFn === 'function' ? extraEnvOrFn(port) : extraEnvOrFn;
  const env = {
    ...process.env, PORT: String(port), SESSION_SECRET: SECRET, NODE_ENV: 'test', ADMIN_PASSWORD,
    PRESENCE_GRACE_MS: '0', FRONTEND_PATH: FRONTEND,
    COVERS_DIR: path.join(os.tmpdir(), 'la-test-covers'),
    INSECURE_DEV_LOGIN: extraEnv.OIDC_ISSUER || extraEnv.OIDC_CLIENT_ID ? '' : '1', ...extraEnv,
  };
  if (!extraEnv.DATABASE_URL) delete env.DATABASE_URL;
  const proc = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  proc.stdout.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${log}`)), 30_000);
    proc.stdout.on('data', (d) => { if (/Server running on port/.test(String(d))) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => { clearTimeout(timer); reject(Object.assign(new Error(`server exited (${code})\n${log}`), { exitCode: code, log })); });
  });
  const stop = () => new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL');
  });
  return { proc, base: `http://127.0.0.1:${port}`, port, stop, log: () => log };
}

/** JSON request helper: req(method, url, { cookie, headers, body }). */
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

module.exports = { SECRET, ADMIN_PASSWORD, cookieFor, centralSessionCookie, adminCookie, freePort, startServer, requester };
