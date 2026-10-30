// Helpers for tests that spawn the real server (src/index.js) as a child
// process. Not a test file itself (the name matches none of node --test's
// patterns).
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SECRET = 'test-session-secret';
const ADMIN_PASSWORD = 'test-admin-pw';
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

/** A signed listen_auth cookie for users.id `userId` (same format as userAuth.createToken). */
function cookieFor(userId, t = Date.now(), secret = SECRET) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `listen_auth=${payload}.${sig}`;
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

/** Start src/index.js; resolves once it listens. DATABASE_URL only if given. */
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), SESSION_SECRET: SECRET, NODE_ENV: 'test', ADMIN_PASSWORD,
    PRESENCE_GRACE_MS: '0', FRONTEND_PATH: FRONTEND,
    COVERS_DIR: path.join(os.tmpdir(), 'la-test-covers'), ...extraEnv,
  };
  if (!extraEnv.DATABASE_URL) delete env.DATABASE_URL;
  const proc = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${log}`)), 30_000);
    proc.stdout.on('data', (d) => { if (/Server running on port/.test(String(d))) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error(`server exited (${code})\n${log}`)));
  });
  const stop = () => new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL');
  });
  return { proc, base: `http://127.0.0.1:${port}`, stop };
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

module.exports = { SECRET, ADMIN_PASSWORD, cookieFor, adminCookie, freePort, startServer, requester };
