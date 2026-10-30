// Server-side authentication / authorization, end to end:
//   1. userAuth.js unit rules (tokens, levels, the route policy table)
//   2. the real server without a database: the guard (401 JSON for APIs,
//      /login?next= for pages), public routes, the ?next flow, the admin
//      cookie, the cover redirect allowlist, OAuth state vs login cookie, and
//      the Socket.IO handshake (anonymous / foreign origin refused)
//   3. the real server on Postgres (testcontainers): approved vs pending vs
//      denied / rejected accounts over HTTP and Socket.IO, CLI Bearer tokens
//      (/api/me, /api/library, upload) untouched, spoofed names ignored.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const userAuthMod = require('./userAuth');

const SECRET = 'auth-guard-test-secret';
const ADMIN_PASSWORD = 'auth-guard-admin-pw';
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const ALICE = '00000000-0000-4000-8000-00000000a11c';

function cookieFor(userId, t = Date.now(), secret = SECRET) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `listen_auth=${payload}.${sig}`;
}

function adminCookie() {
  const prev = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
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

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), SESSION_SECRET: SECRET, NODE_ENV: 'test', ADMIN_PASSWORD,
    PRESENCE_GRACE_MS: '0', FRONTEND_PATH: FRONTEND, GOOGLE_CLIENT_ID: 'test-google-client',
    COVERS_DIR: path.join(os.tmpdir(), 'la-auth-test-covers'), ...extraEnv,
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
  return { proc, base: `http://127.0.0.1:${port}` };
}

function client(base) {
  const sockets = [];
  async function req(method, url, { cookie, headers = {}, body } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  }
  function connect(cookie, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    const s = ioClient(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: headers });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }
  const close = () => { for (const s of sockets) s.disconnect(); };
  return { req, connect, close };
}

function waitFor(socket, events, ms = 1500) {
  return new Promise((resolve) => {
    const handlers = {};
    const done = (result) => {
      clearTimeout(timer);
      for (const e of events) socket.off(e, handlers[e]);
      resolve(result);
    };
    for (const e of events) { handlers[e] = (data) => done([e, data]); socket.on(e, handlers[e]); }
    const timer = setTimeout(() => done(['timeout']), ms);
  });
}

const ask = (s, event, arg) => new Promise((resolve) => s.emit(event, arg, resolve));

// ---------------------------------------------------------------------------

describe('userAuth rules', () => {
  const ua = userAuthMod.createUserAuth({ secret: SECRET, db: { isAvailable: () => false } });

  it('round-trips a token and refuses tampered, foreign-key, future and expired ones', () => {
    const now = Date.now();
    assert.equal(ua.verifyToken(ua.createToken(ALICE, now)).id, ALICE);
    const good = ua.createToken(ALICE, now);
    const [payload, sig] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ id: 'someone-else', t: now })).toString('base64url');
    assert.equal(ua.verifyToken(`${forged}.${sig}`), null);
    assert.equal(ua.verifyToken(`${payload}.${sig.slice(0, -2)}xx`), null);
    assert.equal(ua.verifyToken(cookieFor(ALICE, now, 'other-secret').split('=')[1]), null);
    assert.equal(ua.verifyToken(ua.createToken(ALICE, now + 60 * 60 * 1000)), null, 'issued in the future');
    assert.equal(ua.verifyToken(ua.createToken(ALICE, now - userAuthMod.MAX_AGE_MS - 1000)), null, 'older than 30 days');
    assert.equal(ua.verifyToken(ua.createToken(ALICE, now - userAuthMod.MAX_AGE_MS + 60_000)).id, ALICE);
    assert.equal(ua.verifyToken('garbage'), null);
    assert.equal(ua.verifyToken(''), null);
    assert.equal(ua.userIdFromHeaders({ cookie: `a=b; ${cookieFor(ALICE)}; c=d` }), ALICE);
    assert.equal(ua.userIdFromHeaders({}), null);
  });

  it('levels: approved > pending > denied / rejected', () => {
    const { meetsLevel, refusal } = userAuthMod;
    const acct = (status) => ({ id: 'x', status });
    assert.equal(meetsLevel(acct('approved'), 'approved'), true);
    assert.equal(meetsLevel(acct('pending'), 'approved'), false);
    assert.equal(meetsLevel(acct('pending'), 'member'), true);
    assert.equal(meetsLevel(acct('something-new'), 'approved'), false, 'unknown statuses are not approved');
    for (const s of ['denied', 'rejected']) {
      assert.equal(meetsLevel(acct(s), 'member'), false);
      assert.equal(meetsLevel(acct(s), 'login'), true);
      assert.equal(refusal(acct(s)).body.code, 'ACCOUNT_DENIED');
    }
    assert.equal(meetsLevel(null, 'login'), false);
    assert.equal(refusal(null).status, 401);
    assert.equal(refusal(acct('pending')).body.code, 'ACCOUNT_PENDING');
  });

  it('route policy: deny by default', () => {
    const { policyFor } = userAuthMod;
    const expect = {
      public: ['/health', '/login', '/api/version', '/api/changelog', '/changelog', '/api/auth/me', '/api/auth/providers',
        '/api/auth/logout', '/api/auth/register', '/auth/google', '/auth/github/callback', '/auth/google/link',
        '/youtube-playlist', '/api/youtube-playlist', '/api/youtube-playlist/abc', '/admin', '/api/admin/status',
        '/api/admin/login', '/lobby/abc'],
      self: ['/api/me', '/api/library', '/api/library/upload', '/api/library/x/file', '/api/requests',
        '/api/requests/x/dismiss', '/api/admin/tokens', '/api/dashboard/stats', '/api/auth/users',
        '/api/auth/users/x/status', '/api/chat/messages/1', '/dashboard'],
      member: ['/api/profile', '/api/profile/providers/github'],
      approved: ['/api/playlists', '/api/lobbies/x', '/api/stream', '/api/covers/x', '/api/qr/x', '/api/anything-new',
        '/api/auth/something-new', '/api', '//api/playlists', '/API/playlists', '/Api/Stream'],
      page: ['/', '/library', '/playlist/abc', '/profile', '/social', '/whatever', '/api-docs', '/healthz', '/login2'],
    };
    for (const [policy, paths] of Object.entries(expect)) {
      for (const p of paths) assert.equal(policyFor(p), policy, p);
    }
  });
});

// ---------------------------------------------------------------------------

describe('auth guard against a running server (no database)', { timeout: 60_000 }, () => {
  let srv;
  let c;
  const alice = cookieFor(ALICE);

  before(async () => {
    srv = await startServer();
    c = client(srv.base);
  });
  after(() => {
    if (c) c.close();
    if (srv) srv.proc.kill('SIGKILL');
  });

  it('protected API routes answer 401 JSON without a login', async () => {
    const routes = [
      ['GET', '/api/playlists'], ['POST', '/api/playlists'], ['GET', '/api/lobbies'], ['GET', '/api/playlists/abc'],
      ['PATCH', '/api/playlists/abc'], ['DELETE', '/api/playlists/abc'], ['GET', '/api/stream?q=x'],
      ['GET', '/api/covers/abc'], ['GET', '/api/qr/abc'], ['GET', '/api/profile'], ['PUT', '/api/profile'],
      ['DELETE', '/api/profile/providers/github'], ['GET', '/api/library'], ['GET', '/api/library/abc'],
      ['GET', '/api/library/abc/file'], ['GET', '/api/requests'], ['GET', '/api/nonexistent'],
    ];
    routes.push(['GET', '/API/playlists'], ['GET', '/Api/Library']);
    for (const [method, url] of routes) {
      const r = await c.req(method, url);
      assert.equal(r.status, 401, `${method} ${url}`);
      assert.equal(r.body && r.body.error, 'Authentication required', `${method} ${url}`);
    }
    // A forged, expired or wrong-key cookie is the same as none.
    for (const bad of [cookieFor(ALICE, Date.now() - 31 * 24 * 3600 * 1000), cookieFor(ALICE, Date.now(), 'nope'), 'listen_auth=x.y']) {
      assert.equal((await c.req('GET', '/api/playlists', { cookie: bad })).status, 401);
    }
  });

  it('pages redirect to /login and remember where to come back to', async () => {
    let r = await c.req('GET', '/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
    r = await c.req('GET', '/library?q=daft%20punk&page=2');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login?next=%2Flibrary%3Fq%3Ddaft%2520punk%26page%3D2');
    r = await c.req('GET', '/profile');
    assert.equal(r.headers.get('location'), '/login?next=%2Fprofile');
    // Non-GET to a page path: 401, not a redirect.
    assert.equal((await c.req('POST', '/library')).status, 401);
    // Logged in: the SPA.
    r = await c.req('GET', '/library', { cookie: alice });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    r = await c.req('GET', '/', { cookie: alice });
    assert.equal(r.status, 200);
  });

  it('public routes and static assets need no login', async () => {
    for (const url of ['/health', '/api/version', '/api/changelog', '/changelog', '/admin', '/youtube-playlist',
      '/api/youtube-playlist', '/app.js', '/theme.css', '/favicon.png', '/locales/en.json', '/api/auth/providers', '/api/admin/status']) {
      const r = await c.req('GET', url);
      assert.ok(r.status === 200 || (url === '/api/changelog' && r.status === 404), `${url} -> ${r.status}`);
    }
    const login = await c.req('GET', '/login?next=%2Flibrary');
    assert.equal(login.status, 200);
    assert.match(login.text, /<html/i, 'the SPA login view (index.html)');
    assert.deepEqual((await c.req('GET', '/api/auth/me')).body, { authenticated: false });
    assert.deepEqual((await c.req('POST', '/api/auth/register', { body: { userId: 'user_x', username: 'Evil' } })).body,
      { status: 'unregistered', userId: null });
  });

  it('/login sends a logged-in user on to a same-origin ?next only', async () => {
    let r = await c.req('GET', '/login?next=%2Flibrary%3Fq%3Dx', { cookie: alice });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/library?q=x');
    for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      r = await c.req('GET', `/login?next=${encodeURIComponent(evil)}`, { cookie: alice });
      assert.equal(r.headers.get('location'), '/', evil);
    }
  });

  it('the OAuth ?next cookie only takes same-origin paths', async () => {
    let r = await c.req('GET', '/auth/google?next=%2Fplaylist%2Fabc');
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^https:\/\/accounts\.google\.com\//);
    assert.match(r.headers.get('set-cookie'), /listen_next=%2Fplaylist%2Fabc;.*HttpOnly/i);
    r = await c.req('GET', '/auth/google?next=%2F%2Fevil.example');
    assert.doesNotMatch(r.headers.get('set-cookie') || '', /listen_next=%2F%2Fevil/);
  });

  it('an account-link OAuth state is not a login cookie', async () => {
    const r = await c.req('GET', '/auth/google/link', { cookie: alice });
    assert.equal(r.status, 302);
    const state = new URL(r.headers.get('location')).searchParams.get('state');
    assert.ok(state);
    assert.equal((await c.req('GET', '/api/playlists', { cookie: `listen_auth=${state}` })).status, 401);
    assert.equal((await c.req('GET', '/api/playlists', { cookie: alice })).status, 200);
  });

  it('admin routes need the admin cookie, not a user login', async () => {
    const admin = adminCookie();
    for (const url of ['/api/dashboard/stats', '/api/dashboard/users', '/api/auth/users', '/api/admin/tokens']) {
      assert.equal((await c.req('GET', url)).status, 401, url);
      assert.equal((await c.req('GET', url, { cookie: alice })).status, 401, `${url} with a user login`);
    }
    assert.equal((await c.req('GET', '/api/dashboard/stats', { cookie: admin })).status, 200);
    assert.equal((await c.req('DELETE', '/api/chat/messages/1', { cookie: alice })).status, 401);
    let r = await c.req('GET', '/dashboard');
    assert.equal(r.headers.get('location'), '/admin?next=/dashboard');
    r = await c.req('GET', '/dashboard', { cookie: admin });
    assert.equal(r.status, 200);
    // Library reads accept the admin cookie (the admin page lists and previews).
    assert.equal((await c.req('GET', '/api/library', { cookie: admin })).status, 503, 'past auth: no database here');
    assert.equal((await c.req('GET', '/api/library', { cookie: alice })).status, 503, 'past auth: no database here');
  });

  it('cover fallback only redirects to known thumbnail hosts', async () => {
    const ok = await c.req('GET', `/api/covers/nope?fallback=${encodeURIComponent('https://i.ytimg.com/vi/x/hqdefault.jpg')}`, { cookie: alice });
    assert.equal(ok.status, 302);
    for (const evil of ['https://evil.example/x.png', 'https://ytimg.com.evil.example/', 'javascript:alert(1)', 'https://user@i.ytimg.com/']) {
      const r = await c.req('GET', `/api/covers/nope?fallback=${encodeURIComponent(evil)}`, { cookie: alice });
      assert.equal(r.status, 400, evil);
    }
  });

  it('sockets: anonymous, forged and foreign-origin handshakes are refused', async () => {
    await assert.rejects(c.connect(null), /Authentication required/);
    await assert.rejects(c.connect('listen_auth=x.y'), /Authentication required/);
    await assert.rejects(c.connect(cookieFor(ALICE, Date.now(), 'nope')), /Authentication required/);
    await assert.rejects(c.connect(alice, { origin: 'https://evil.example' }), /Origin not allowed/);
    const s = await c.connect(alice, { origin: srv.base });
    assert.ok(s.connected);
    // The public /youtube-playlist namespace stays open.
    const yt = ioClient(`${srv.base}/youtube-playlist`, { transports: ['websocket'], forceNew: true, reconnection: false });
    const [ev] = await waitFor(yt, ['songs', 'connect_error']);
    yt.disconnect();
    assert.equal(ev, 'songs');
  });
});

// ---------------------------------------------------------------------------

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const pgSkip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('account status and CLI tokens on Postgres', { skip: pgSkip, timeout: 180_000 }, () => {
  let container;
  let pg;
  let srv;
  let c;
  let token;
  let tmp;
  const ids = {};
  const cookies = {};

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_auth').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-auth-test-'));
    srv = await startServer({ DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') });
    c = client(srv.base);

    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();
    for (const status of ['approved', 'pending', 'denied', 'rejected']) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, email, status, created_at) VALUES ('github', $1, $2, $3, $4, 1) RETURNING id`,
        [status, `User ${status}`, `${status}@example.com`, status]
      );
      ids[status] = r.rows[0].id;
      cookies[status] = cookieFor(ids[status]);
    }
    const r = await pg.query(`INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ('github', 'victim', 'Victim', 'approved', 1) RETURNING id`);
    ids.victim = r.rows[0].id;
    cookies.victim = cookieFor(ids.victim);
    // A CLI token, stored as the server stores it (sha256 hash).
    token = 'la_' + crypto.randomBytes(32).toString('base64url');
    await pg.query('INSERT INTO api_tokens (name, token_hash, token_prefix) VALUES ($1, $2, $3)',
      ['Uploader', crypto.createHash('sha256').update(token).digest('hex'), token.slice(0, 10)]);
  });

  after(async () => {
    if (c) c.close();
    if (srv) srv.proc.kill('SIGKILL');
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const bearer = (t = token) => ({ Authorization: `Bearer ${t}` });

  it('approved: full access over HTTP', async () => {
    assert.equal((await c.req('GET', '/api/playlists', { cookie: cookies.approved })).status, 200);
    assert.equal((await c.req('GET', '/api/library', { cookie: cookies.approved })).status, 200);
    assert.equal((await c.req('GET', '/api/requests', { cookie: cookies.approved })).status, 200);
    assert.equal((await c.req('GET', '/api/profile', { cookie: cookies.approved })).status, 200);
  });

  it('pending: own account, profile and chat only', async () => {
    const me = await c.req('GET', '/api/auth/me', { cookie: cookies.pending });
    assert.equal(me.body.user.status, 'pending');
    assert.equal((await c.req('GET', '/api/profile', { cookie: cookies.pending })).status, 200);
    for (const url of ['/api/playlists', '/api/library', '/api/requests', '/api/stream?q=x', '/api/qr/abc']) {
      const r = await c.req('GET', url, { cookie: cookies.pending });
      assert.equal(r.status, 403, url);
      assert.equal(r.body.code, 'ACCOUNT_PENDING', url);
    }
    assert.equal((await c.req('GET', '/API/Playlists', { cookie: cookies.pending })).status, 403, 'case does not dodge the check');
    assert.equal((await c.req('POST', '/api/playlists', { cookie: cookies.pending, body: { name: 'x' } })).status, 403);
    // The SPA loads (it shows the pending screen itself).
    assert.equal((await c.req('GET', '/', { cookie: cookies.pending })).status, 200);

    const s = await c.connect(cookies.pending);
    const people = await ask(s, 'people:list');
    assert.ok(Array.isArray(people.people), 'pending users see the people panel');
    const sent = await ask(s, 'chat:send', { text: 'hello from pending' });
    assert.equal(sent.ok, true, 'pending users can chat');
    s.emit('lobby:create', { name: 'Nope' });
    const [ev, data] = await waitFor(s, ['lobby:error', 'lobby:created']);
    assert.equal(ev, 'lobby:error');
    assert.equal(data.code, 'ACCOUNT_PENDING');
    s.emit('lobby:join', { lobbyId: 'whatever' });
    assert.equal((await waitFor(s, ['lobby:error', 'lobby:joined', 'lobby:not-found']))[0], 'lobby:error');
  });

  it('denied / rejected: blocked everywhere but /api/auth/me', async () => {
    for (const status of ['denied', 'rejected']) {
      const me = await c.req('GET', '/api/auth/me', { cookie: cookies[status] });
      assert.equal(me.body.user.status, status);
      for (const url of ['/api/playlists', '/api/profile', '/api/library', '/api/requests']) {
        const r = await c.req('GET', url, { cookie: cookies[status] });
        assert.equal(r.status, 403, `${status} ${url}`);
        assert.equal(r.body.code, 'ACCOUNT_DENIED');
      }
      await assert.rejects(c.connect(cookies[status]), /Access denied/, status);
    }
  });

  it('a signed cookie for an account that does not exist is no login', async () => {
    const ghost = cookieFor('00000000-0000-4000-8000-0000000000ff');
    assert.equal((await c.req('GET', '/api/playlists', { cookie: ghost })).status, 401);
    assert.equal((await c.req('GET', '/', { cookie: ghost })).status, 302);
    assert.equal((await c.req('GET', '/login', { cookie: ghost })).status, 200, 'no redirect loop');
    await assert.rejects(c.connect(ghost), /Authentication required/);
  });

  it('legacy register/status only report the caller and create nothing', async () => {
    const before = (await pg.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    let r = await c.req('POST', '/api/auth/register', { cookie: cookies.pending, body: { userId: 'user_evil', username: 'Evil' } });
    assert.deepEqual(r.body, { status: 'pending', userId: ids.pending });
    r = await c.req('GET', `/api/auth/status?userId=${ids.denied}`, { cookie: cookies.approved });
    assert.equal(r.body.status, 'approved', "never another user's status");
    await c.req('POST', '/api/auth/register', { body: { userId: 'user_evil2', username: 'Evil' } });
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM users')).rows[0].n, before);
  });

  it('CLI Bearer token: /api/me, /api/library and upload keep working', async () => {
    let r = await c.req('GET', '/api/me', { headers: bearer() });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Uploader');
    assert.equal(r.body.user, null, 'a legacy token has no owner');
    assert.equal((await c.req('GET', '/api/me')).status, 401);
    assert.equal((await c.req('GET', '/api/me', { headers: bearer('la_wrong') })).status, 401);
    r = await c.req('GET', '/api/library?limit=5', { headers: bearer() });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.songs));
    assert.equal((await c.req('GET', '/api/library', { headers: bearer('la_wrong') })).status, 401);
    assert.equal((await c.req('GET', '/api/requests', { headers: bearer() })).status, 200);

    // Upload: without a token 401 before anything is stored; with one the
    // request reaches validation (a non-m4a name is refused with 400).
    const fd = () => { const f = new FormData(); f.append('file', new Blob([Buffer.from('not audio')], { type: 'audio/mp4' }), 'x.txt'); f.append('title', 't'); f.append('artist', 'a'); return f; };
    let up = await fetch(`${srv.base}/api/library/upload`, { method: 'POST', body: fd() });
    assert.equal(up.status, 401);
    up = await fetch(`${srv.base}/api/library/upload`, { method: 'POST', body: fd(), headers: bearer() });
    assert.equal(up.status, 400);
    assert.match((await up.json()).error, /\.m4a/);
  });

  it('a real upload with a token, then queue:add ignores a spoofed addedBy', { skip: !has('ffmpeg -version') || !has('ffprobe -version') ? 'ffmpeg not available' : false }, async () => {
    const file = path.join(tmp, 'tone.m4a');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', file]);
    const f = new FormData();
    f.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mp4' }), 'tone.m4a');
    f.append('title', 'Auth Tone');
    f.append('artist', 'Guard');
    const up = await fetch(`${srv.base}/api/library/upload`, { method: 'POST', body: f, headers: bearer() });
    assert.equal(up.status, 201);
    const { song } = await up.json();

    const s = await c.connect(cookies.approved);
    s.emit('lobby:create', { name: 'Spoof test', username: 'Mallory' });
    const [, created] = await waitFor(s, ['lobby:created']);
    assert.equal(created.user.username, 'User approved', 'listed under the account name, not the client name');
    s.emit('queue:add', { lobbyId: created.lobbyId, libraryId: song.id, addedBy: 'Mallory', userId: ids.victim });
    const [ev, upd] = await waitFor(s, ['queue:update', 'queue:error'], 3000);
    assert.equal(ev, 'queue:update');
    assert.equal(upd.songs.at(-1).addedBy, 'User approved');
    s.emit('user:update', { username: 'Mallory' });
    const [, users] = await waitFor(s, ['users:updated']);
    assert.equal(users.users[0].username, 'User approved');
  });

  it('rejecting an account disconnects its sockets and blocks it at once', async () => {
    const s = await c.connect(cookies.victim);
    assert.equal((await c.req('GET', '/api/playlists', { cookie: cookies.victim })).status, 200);
    const gone = new Promise((resolve) => s.on('disconnect', resolve));
    const r = await c.req('PUT', `/api/dashboard/users/${ids.victim}/reject`, { cookie: adminCookie() });
    assert.equal(r.status, 200);
    await gone;
    assert.equal((await c.req('GET', '/api/playlists', { cookie: cookies.victim })).status, 403);
    await assert.rejects(c.connect(cookies.victim), /Access denied/);
    // And the dashboard itself still needs the admin cookie.
    assert.equal((await c.req('PUT', `/api/dashboard/users/${ids.victim}/approve`, { cookie: cookies.approved })).status, 401);
  });
});
