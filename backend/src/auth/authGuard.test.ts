// Server-side authentication / authorization, end to end:
//   1. userAuth.ts / devLogin.ts unit rules (dev sign-in cookie, levels, the
//      route policy table)
//   2. boot: which sign-in may run where (production needs the central login
//      and refuses the dev sign-in; no sign-in at all refuses to start)
//   3. the real server without a database (dev sign-in): the guard (401 JSON
//      for APIs, /login?next= for pages), public routes, the ?next flow, the
//      admin cookie, the cover redirect allowlist, the removed Google / GitHub
//      routes and old cookie, and the Socket.IO handshake (anonymous / foreign
//      origin refused)
//   4. the real server on Postgres (testcontainers): approved vs pending vs
//      denied / rejected accounts over HTTP and Socket.IO, CLI Bearer tokens
//      (/api/me, /api/library, upload) untouched, spoofed names ignored.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pgModule from 'pg';
import { io as ioClient } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Request } from 'express';
import * as userAuthMod from './userAuth.ts';
import * as devLogin from './devLogin.ts';
import * as adminAuth from './adminAuth.ts';
import { listening, SERVER_ENTRY } from '../testing/testServer.ts';
import type { AuthIo } from './authRoutes.ts';
import type { SessionLookup, UserAuthDb } from './userAuth.ts';
import type { Account } from './types.ts';
import type { OidcSessions } from './oidcSessions.ts';
import type { Io } from '../shared/types.ts';

// The server's and the database's JSON, read as the tests need it.
type Payload = any;
type Server = Awaited<ReturnType<typeof startServer>>;
type Client = ReturnType<typeof client>;

// What index.js passes (index.js is not typechecked): the real Socket.IO server
// fits what sign-in uses of it, and the central login's sessions fit userAuth.
export const realServerFits = (io: Io): AuthIo => io;
export const realSessionsFit = (sessions: OidcSessions): SessionLookup => sessions;

const SECRET = 'auth-guard-test-secret';
const ADMIN_PASSWORD = 'auth-guard-admin-pw';
const FRONTEND = path.join(import.meta.dirname, '..', '..', '..', 'frontend');
const ALICE = '00000000-0000-4000-8000-00000000a11c';

// The dev sign-in cookie (devLogin.ts); every server here runs with INSECURE_DEV_LOGIN=1.
function cookieFor(userId: string, t = Date.now(), secret = SECRET) {
  return `${devLogin.DEV_COOKIE}=${devLogin.signDevToken(secret, userId, t)}`;
}

// The removed Google / GitHub login's cookie, exactly as it was signed (same
// secret): it must never be a login again.
function legacyCookie(userId: string, t = Date.now(), secret = SECRET) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `listen_auth=${payload}.${sig}`;
}

function adminCookie() {
  const prev = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  const v = `la_admin=${encodeURIComponent(adminAuth.createSessionValue())}`;
  if (prev === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prev;
  return v;
}

async function startServer(extraEnv: Record<string, string> = {}) {
  // Port 0: the server binds a free port itself and says which (testServer.listening).
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: '0', SESSION_SECRET: SECRET, NODE_ENV: 'test', ADMIN_PASSWORD,
    PRESENCE_GRACE_MS: '0', FRONTEND_PATH: FRONTEND, INSECURE_DEV_LOGIN: '1',
    COVERS_DIR: path.join(os.tmpdir(), 'la-auth-test-covers'), ...extraEnv,
  };
  if (!extraEnv.DATABASE_URL) delete env.DATABASE_URL;
  const proc = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await listening(proc);
  return { proc, base: `http://127.0.0.1:${port}` };
}

/** Spawn the server with exactly `env` (+ PORT); resolves { code, log } once it exits or listens. */
function boot(env: Record<string, string>): Promise<{ code: number | null; listening: boolean; log: string }> {
  return new Promise((resolve) => {
    const full = { PATH: process.env.PATH, PORT: '0', FRONTEND_PATH: FRONTEND, PRESENCE_GRACE_MS: '0', ...env };
    const proc = spawn(process.execPath, [SERVER_ENTRY], { env: full, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let listening = false;
    proc.stdout.on('data', (d) => { log += d; if (/Server running on port/.test(log)) { listening = true; proc.kill('SIGKILL'); } });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code) => resolve({ code, listening, log }));
    setTimeout(() => proc.kill('SIGKILL'), 20_000);
  });
}

function client(base: string) {
  const sockets: Socket[] = [];
  async function req(method: string, url: string, { cookie, headers = {}, body }: { cookie?: string; headers?: Record<string, string>; body?: Payload } = {}): Promise<{ status: number; body: Payload; text: string; headers: Headers }> {
    const h: Record<string, string> = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  }
  function connect(cookie?: string | null, extraHeaders: Record<string, string> = {}): Promise<Socket> {
    const headers: Record<string, string> = { ...extraHeaders };
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

function waitFor(socket: Socket, events: string[], ms = 1500): Promise<Payload[]> {
  return new Promise((resolve) => {
    const handlers: Record<string, (data: Payload) => void> = {};
    const done = (result: Payload[]) => {
      clearTimeout(timer);
      for (const e of events) socket.off(e, handlers[e]);
      resolve(result);
    };
    for (const e of events) { handlers[e] = (data: Payload) => done([e, data]); socket.on(e, handlers[e]); }
    const timer = setTimeout(() => done(['timeout']), ms);
  });
}

const ask = (s: Socket, event: string, arg?: Payload): Promise<Payload> => new Promise((resolve) => s.emit(event, arg, resolve));

// ---------------------------------------------------------------------------

describe('userAuth rules', () => {
  const noDb = { isAvailable: () => false } as UserAuthDb;

  it('dev sign-in token: round-trips; tampered, foreign-key, future and expired ones are refused', () => {
    const { signDevToken: sign, verifyDevToken: verify, MAX_AGE_MS } = devLogin;
    const now = Date.now();
    assert.equal(verify(SECRET, sign(SECRET, ALICE, now))!.id, ALICE);
    const [payload, sig] = sign(SECRET, ALICE, now).split('.');
    const forged = Buffer.from(JSON.stringify({ id: 'someone-else', t: now })).toString('base64url');
    assert.equal(verify(SECRET, `${forged}.${sig}`), null);
    assert.equal(verify(SECRET, `${payload}.${sig.slice(0, -2)}xx`), null);
    assert.equal(verify(SECRET, sign('other-secret', ALICE, now)), null);
    assert.equal(verify(SECRET, legacyCookie(ALICE, now).split('=')[1]), null, 'an old listen_auth token, same secret, is not one');
    assert.equal(verify(SECRET, sign(SECRET, ALICE, now + 60 * 60 * 1000)), null, 'issued in the future');
    assert.equal(verify(SECRET, sign(SECRET, ALICE, now - MAX_AGE_MS - 1000)), null, 'older than 30 days');
    assert.equal(verify(SECRET, sign(SECRET, ALICE, now - MAX_AGE_MS + 60_000))!.id, ALICE);
    assert.equal(verify(SECRET, 'garbage'), null);
    assert.equal(verify(SECRET, ''), null);
    assert.equal(verify('', sign(SECRET, ALICE, now)), null);
  });

  it('dev sign-in: only la_dev_login is read; central login ignores it; one way in at a time', async () => {
    const dev = userAuthMod.createUserAuth({ secret: SECRET, db: noDb, devLogin: true });
    assert.equal(dev.mode, 'dev');
    assert.deepEqual(await dev.resolve({ cookie: `a=b; ${cookieFor(ALICE)}; c=d` }), { userId: ALICE, sessionId: null });
    assert.equal(await dev.resolve({}), null);
    assert.equal(await dev.resolve({ cookie: legacyCookie(ALICE) }), null, 'the old listen_auth cookie is no login');
    const sessions = { resolveHeaders: async (h: { cookie?: string }) => (h.cookie === 'la_session=ok' ? { userId: 'u1', idHash: 'h1' } : null) } as unknown as SessionLookup;
    const central = userAuthMod.createUserAuth({ secret: SECRET, db: noDb, sessions });
    assert.equal(central.mode, 'central');
    assert.equal(await central.resolve({ cookie: cookieFor(ALICE) }), null, 'a dev cookie is no login with central login');
    assert.equal(await central.resolve({ cookie: legacyCookie(ALICE) }), null);
    assert.deepEqual(await central.resolve({ cookie: 'la_session=ok' }), { userId: 'u1', sessionId: 'h1' });
    assert.throws(() => userAuthMod.createUserAuth({ secret: SECRET, db: noDb }), /exactly one/);
    assert.throws(() => userAuthMod.createUserAuth({ secret: SECRET, db: noDb, sessions, devLogin: true }), /exactly one/);
  });

  it('INSECURE_DEV_LOGIN: only with NODE_ENV development / test, never production, never next to central login', () => {
    const { readDevLogin, DevLoginError } = devLogin;
    assert.equal(readDevLogin({}), false);
    assert.equal(readDevLogin({ INSECURE_DEV_LOGIN: '0', NODE_ENV: 'production' }), false);
    assert.equal(readDevLogin({ INSECURE_DEV_LOGIN: '1', NODE_ENV: 'test' }), true);
    assert.equal(readDevLogin({ INSECURE_DEV_LOGIN: ' 1 ', NODE_ENV: 'development' }), true);
    for (const env of [
      { INSECURE_DEV_LOGIN: '1', NODE_ENV: 'production' },
      { INSECURE_DEV_LOGIN: '1' },
      { INSECURE_DEV_LOGIN: '1', NODE_ENV: 'staging' },
      { INSECURE_DEV_LOGIN: 'yes', NODE_ENV: 'test' },
      { INSECURE_DEV_LOGIN: '1', NODE_ENV: 'test', OIDC_ISSUER: 'http://127.0.0.1:9/' },
      { INSECURE_DEV_LOGIN: '1', NODE_ENV: 'test', OIDC_CLIENT_ID: 'listen-along' },
    ]) assert.throws(() => readDevLogin(env), DevLoginError, JSON.stringify(env));
    assert.throws(() => readDevLogin({ INSECURE_DEV_LOGIN: '1', NODE_ENV: 'production' }), /refused in production/);
  });

  it('levels: approved > pending > denied / rejected', () => {
    const { meetsLevel, refusal } = userAuthMod;
    const acct = (status: string) => ({ id: 'x', status, name: null, emoji: null }) as Account;
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
        '/api/auth/logout', '/api/auth/register', '/auth/oidc/login', '/auth/oidc/callback', '/auth/dev/login',
        '/admin', '/api/admin/status',
        '/api/admin/login', '/lobby/abc'],
      self: ['/api/me', '/api/library', '/api/library/upload', '/api/library/x/file', '/api/requests',
        '/api/requests/x/dismiss', '/api/admin/tokens', '/api/dashboard/stats', '/api/auth/users',
        '/api/auth/users/x/status', '/api/chat/messages/1', '/dashboard', '/api/cli/latest', '/api/cli/bundle'],
      member: ['/api/profile', '/api/profile/activity'],
      approved: ['/api/playlists', '/api/lobbies/x', '/api/stream', '/api/covers/x', '/api/qr/x', '/api/anything-new',
        '/api/auth/something-new', '/api', '//api/playlists', '/API/playlists', '/Api/Stream',
        '/api/jobs', '/api/jobs/picks', '/api/activity/downloads', '/api/activity'],
      page: ['/', '/library', '/playlist/abc', '/profile', '/social', '/whatever', '/api-docs', '/healthz', '/login2',
        '/auth/google', '/auth/github/callback', '/auth/whatever'],
    };
    for (const [policy, paths] of Object.entries(expect)) {
      for (const p of paths) assert.equal(policyFor(p), policy, p);
    }
  });
});

// ---------------------------------------------------------------------------

describe('sign-in at boot: production needs the central login and refuses the dev sign-in', { timeout: 60_000 }, () => {
  const prod = {
    NODE_ENV: 'production', SESSION_SECRET: SECRET,
    // An https IdP that does not answer: the server still starts (sign-in retries discovery).
    OIDC_ISSUER: 'https://127.0.0.1:9/application/o/listen-along/', OIDC_CLIENT_ID: 'listen-along',
    BASE_URL: 'https://music.example.com',
  };

  it('production with the central login configured starts', async () => {
    const r = await boot(prod);
    assert.ok(r.listening, r.log);
    // FRONTEND_URL alone still stands in for BASE_URL, as it always did.
    const viaFrontend = await boot({ ...prod, BASE_URL: '', FRONTEND_URL: 'https://music.example.com' });
    assert.ok(viaFrontend.listening, viaFrontend.log);
  });

  it('NODE_ENV unset with the OIDC variables: central login, never the dev sign-in', async () => {
    const { NODE_ENV, ...unset } = prod;
    const r = await boot({ ...unset, BASE_URL: 'http://127.0.0.1:1' });
    assert.ok(r.listening, r.log);
    assert.doesNotMatch(r.log, /INSECURE_DEV_LOGIN is on/);
    assert.match(r.log, /\[oidc\]/);
    const withFlag = await boot({ ...unset, INSECURE_DEV_LOGIN: '1' });
    assert.equal(withFlag.code, 1);
    assert.match(withFlag.log, /needs NODE_ENV=development or NODE_ENV=test/);
  });

  it('production refuses INSECURE_DEV_LOGIN, with or without central login', async () => {
    for (const env of [{ ...prod, INSECURE_DEV_LOGIN: '1' }, { NODE_ENV: 'production', SESSION_SECRET: SECRET, INSECURE_DEV_LOGIN: '1' }]) {
      const r = await boot(env);
      assert.equal(r.listening, false, r.log);
      assert.equal(r.code, 1);
      assert.match(r.log, /INSECURE_DEV_LOGIN is refused in production/);
    }
  });

  it('production without OIDC_ISSUER / OIDC_CLIENT_ID / BASE_URL or FRONTEND_URL / SESSION_SECRET refuses to start', async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ NODE_ENV: 'production', SESSION_SECRET: SECRET }, /central login is required in production/],
      [{ ...prod, OIDC_ISSUER: '' }, /half-configured/],
      [{ ...prod, OIDC_CLIENT_ID: '' }, /half-configured/],
      [{ ...prod, BASE_URL: '' }, /BASE_URL \(or FRONTEND_URL\) must be set/],
      [{ ...prod, SESSION_SECRET: '' }, /SESSION_SECRET must be set/],
    ];
    for (const [env, why] of cases) {
      const r = await boot(env);
      assert.equal(r.listening, false, r.log);
      assert.equal(r.code, 1);
      assert.match(r.log, why);
    }
  });

  it('no sign-in at all refuses to start outside production too; the dev sign-in needs NODE_ENV development / test', async () => {
    let r = await boot({ NODE_ENV: 'development', SESSION_SECRET: SECRET });
    assert.equal(r.code, 1);
    assert.match(r.log, /no sign-in configured/);
    r = await boot({ SESSION_SECRET: SECRET, INSECURE_DEV_LOGIN: '1' });
    assert.equal(r.code, 1);
    assert.match(r.log, /needs NODE_ENV=development or NODE_ENV=test/);
    r = await boot({ NODE_ENV: 'development', SESSION_SECRET: SECRET, INSECURE_DEV_LOGIN: '1' });
    assert.ok(r.listening, r.log);
    assert.match(r.log, /INSECURE_DEV_LOGIN is on/);
  });

  it('a production server never accepts the dev sign-in cookie, and has no dev sign-in route', async () => {
    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { PATH: process.env.PATH, PORT: '0', FRONTEND_PATH: FRONTEND, ...prod }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const port = await listening(proc);
      const c = client(`http://127.0.0.1:${port}`);
      // Signed with the server's own SESSION_SECRET: still no login.
      for (const cookie of [cookieFor(ALICE), legacyCookie(ALICE)]) {
        assert.equal((await c.req('GET', '/api/playlists', { cookie })).status, 401);
        assert.equal((await c.req('GET', '/', { cookie })).headers.get('location'), '/login');
        await assert.rejects(c.connect(cookie), /Authentication required/);
      }
      const dev = await c.req('GET', '/auth/dev/login?user=x');
      assert.equal(dev.status, 404);
      assert.equal(dev.headers.get('set-cookie'), null);
      assert.deepEqual((await c.req('GET', '/api/auth/providers')).body, { central: true, dev: false });
      c.close();
    } finally { proc.kill('SIGKILL'); }
  });
});

// ---------------------------------------------------------------------------

describe('auth guard against a running server (no database, dev sign-in)', { timeout: 60_000 }, () => {
  let srv: Server;
  let c: Client;
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
      ['GET', '/api/library'], ['GET', '/api/library/abc'],
      ['GET', '/api/library/abc/file'], ['GET', '/api/requests'], ['GET', '/api/nonexistent'],
      ['GET', '/api/activity/downloads'],
    ];
    routes.push(['GET', '/API/playlists'], ['GET', '/Api/Library']);
    for (const [method, url] of routes) {
      const r = await c.req(method, url);
      assert.equal(r.status, 401, `${method} ${url}`);
      assert.equal(r.body && r.body.error, 'Authentication required', `${method} ${url}`);
    }
    // A forged, expired or wrong-key cookie is the same as none; so is the old
    // Google / GitHub login cookie, even signed with this server's secret.
    for (const bad of [cookieFor(ALICE, Date.now() - 31 * 24 * 3600 * 1000), cookieFor(ALICE, Date.now(), 'nope'), 'la_dev_login=x.y', legacyCookie(ALICE)]) {
      assert.equal((await c.req('GET', '/api/playlists', { cookie: bad })).status, 401);
    }
  });

  it('the downloads activity log is empty without a database (there are no jobs)', async () => {
    const r = await c.req('GET', '/api/activity/downloads', { cookie: alice });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.jobs, []);
    assert.equal(r.body.workers.online, 0);
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
    assert.match(r.headers.get('content-type')!, /text\/html/);
    r = await c.req('GET', '/', { cookie: alice });
    assert.equal(r.status, 200);
  });

  it('public routes and static assets need no login', async () => {
    for (const url of ['/health', '/api/version', '/api/changelog', '/changelog',
      '/app.js', '/theme.css', '/favicon.png', '/locales/en.json', '/api/auth/providers', '/api/admin/status']) {
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

  it('dev sign-in: sets the cookie and goes on to a same-origin ?next only; logout clears it', async () => {
    let r = await c.req('GET', '/auth/dev/login?next=%2Fplaylist%2Fabc');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/playlist/abc');
    const set = r.headers.get('set-cookie')!;
    assert.match(set, /^la_dev_login=[^;]+;.*HttpOnly/i);
    const cookie = set.split(';')[0];
    assert.equal((await c.req('GET', '/api/playlists', { cookie })).status, 200, 'without a database: the id "dev", approved');
    r = await c.req('GET', `/auth/dev/login?user=${ALICE}&next=${encodeURIComponent('//evil.example')}`);
    assert.equal(r.headers.get('location'), '/');
    assert.deepEqual((await c.req('GET', '/api/auth/providers')).body, { central: false, dev: true });
    const out = await c.req('POST', '/api/auth/logout', { cookie });
    assert.deepEqual(out.body, { success: true });
    assert.match(out.headers.get('set-cookie')!, /la_dev_login=;/);
  });

  it('Google / GitHub sign-in, linking and the central login routes are not there', async () => {
    for (const p of ['/auth/google', '/auth/google/callback', '/auth/github', '/auth/github/callback',
      '/auth/google/link', '/auth/google/link/callback', '/auth/github/link', '/auth/github/link/callback']) {
      assert.equal((await c.req('GET', p)).status, 404, p);
      assert.equal((await c.req('GET', p, { cookie: alice })).status, 404, `${p} signed in`);
    }
    for (const p of ['/auth/oidc/login', '/auth/oidc/callback?code=x&state=y']) assert.equal((await c.req('GET', p)).status, 404, p);
    assert.equal((await c.req('DELETE', '/api/profile/providers/github', { cookie: alice })).status, 404);
  });

  it('admin routes need the admin cookie, not a user login', async () => {
    const admin = adminCookie();
    for (const url of ['/api/dashboard/stats', '/api/dashboard/users', '/api/auth/users', '/api/admin/tokens']) {
      assert.equal((await c.req('GET', url)).status, 401, url);
      assert.equal((await c.req('GET', url, { cookie: alice })).status, 401, `${url} with a user login`);
    }
    assert.equal((await c.req('GET', '/api/dashboard/stats', { cookie: admin })).status, 200);
    assert.equal((await c.req('DELETE', '/api/chat/messages/1', { cookie: alice })).status, 401);
    // The page is only the SPA shell (its login form asks for the admin password).
    assert.equal((await c.req('GET', '/dashboard')).status, 200);
    assert.equal((await c.req('GET', '/dashboard', { cookie: admin })).status, 200);
    // Library reads accept the admin cookie (the admin page lists and previews).
    assert.equal((await c.req('GET', '/api/library', { cookie: admin })).status, 503, 'past auth: no database here');
    assert.equal((await c.req('GET', '/api/library', { cookie: alice })).status, 503, 'past auth: no database here');
  });

  it('cover fallback only redirects to known thumbnail hosts', async () => {
    const ok = await c.req('GET', `/api/covers/nope?fallback=${encodeURIComponent('https://i.ytimg.com/vi/x/hqdefault.jpg')}`, { cookie: alice });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), 'https://i.ytimg.com/vi/x/hqdefault.jpg');
    for (const evil of ['https://evil.example/x.png', 'https://ytimg.com.evil.example/', 'javascript:alert(1)', 'https://user@i.ytimg.com/',
      'https://sites.googleusercontent.com/x', 'https://www.youtube.com/redirect?q=https://evil.example', '//i.ytimg.com/x']) {
      const r = await c.req('GET', `/api/covers/nope?fallback=${encodeURIComponent(evil)}`, { cookie: alice });
      assert.equal(r.status, 400, evil);
    }
    const twice = await c.req('GET', `/api/covers/nope?fallback=${encodeURIComponent('https://i.ytimg.com/a.jpg')}&fallback=x`, { cookie: alice });
    assert.equal(twice.status, 400, 'a repeated parameter is not a URL');
    // The target is a fixed https origin + the given path and query.
    const { coverRedirectTarget } = await import('../core/library/index.ts');
    assert.equal(coverRedirectTarget('http://i.scdn.co/image/ab67?x=1#f'), 'https://i.scdn.co/image/ab67?x=1');
    assert.equal(coverRedirectTarget('https://i.ytimg.com\\@evil.example/x'), 'https://i.ytimg.com/@evil.example/x');
    assert.equal(coverRedirectTarget('https://i.ytimg.com:8443/x'), null, 'no other port');
    assert.equal(coverRedirectTarget(['https://i.ytimg.com/x']), null);
  });

  it('sockets: anonymous, forged and foreign-origin handshakes are refused', async () => {
    await assert.rejects(c.connect(null), /Authentication required/);
    await assert.rejects(c.connect('la_dev_login=x.y'), /Authentication required/);
    await assert.rejects(c.connect(legacyCookie(ALICE)), /Authentication required/);
    await assert.rejects(c.connect(cookieFor(ALICE, Date.now(), 'nope')), /Authentication required/);
    await assert.rejects(c.connect(alice, { origin: 'https://evil.example' }), /Origin not allowed/);
    const s = await c.connect(alice, { origin: srv.base });
    assert.ok(s.connected);
  });
});

// ---------------------------------------------------------------------------

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}
const has = (cmd: string) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const pgSkip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('account status and CLI tokens on Postgres', { skip: pgSkip, timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pg: pgModule.Client;
  let srv: Server;
  let c: Client;
  let token: string;
  let tmp: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine')
      .withDatabase('listen_auth').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-auth-test-'));
    srv = await startServer({
      DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'),
      APP_RELEASES_API_URL: 'http://127.0.0.1:9/', // never GitHub from a test; the endpoint answers 200 anyway
    });
    c = client(srv.base);

    const { Client } = pgModule;
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
    // The install page and its release info work before approval.
    assert.equal((await c.req('GET', '/api/app/latest', { cookie: cookies.pending })).status, 200);
    assert.equal((await c.req('GET', '/app', { cookie: cookies.pending })).status, 200);
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

  it('dev sign-in on Postgres: ?user signs that account in; unknown ids refused; no ?user = one "Dev User"', async () => {
    let r = await c.req('GET', `/auth/dev/login?user=${ids.pending}`);
    assert.equal(r.status, 302);
    const pendingCookie = r.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await c.req('GET', '/api/auth/me', { cookie: pendingCookie })).body.user.status, 'pending');
    r = await c.req('GET', '/auth/dev/login?user=00000000-0000-4000-8000-0000000000ff');
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('set-cookie'), null);
    const before = (await pg.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const first = (await c.req('GET', '/auth/dev/login')).headers.get('set-cookie')!.split(';')[0];
    const second = (await c.req('GET', '/auth/dev/login')).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM users')).rows[0].n, before + 1, 'made once');
    const a = (await c.req('GET', '/api/auth/me', { cookie: first })).body.user;
    assert.equal(a.name, 'Dev User');
    assert.equal(a.status, 'approved');
    assert.equal((await c.req('GET', '/api/auth/me', { cookie: second })).body.user.id, a.id);
    await pg.query(`DELETE FROM users WHERE provider = 'dev'`);
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
    assert.match(((await up.json()) as Payload).error, /\.m4a/);
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
    const { song }: Payload = await up.json();

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
