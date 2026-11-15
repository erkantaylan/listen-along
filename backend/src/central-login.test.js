// Central login (OIDC) end to end, against a fake OpenID provider
// (fakeOidcIssuer.js) and the real server (src/index.js as a child process):
//   1. unit rules: configuration, secret boxes, upstream_identities parsing,
//      userAuth in central-login mode
//   2. boot: half-configured / malformed issuer refuse to start; an unreachable
//      IdP does not stop the server and sign-in works once it is back
//   3. the protocol, without a database: happy path, every validation failure
//      (state, nonce, PKCE, audience, issuer, expiry, signature, flow cookie),
//      the old cookie is never a session, Google / GitHub routes are gone,
//      re-check with the refresh token (rotation, single-flight, invalid_grant,
//      IdP down, the unverified cap, long-lived sockets), logout, rate limit
//   4. on Postgres: linking rules a-e, ambiguous and unsafe matches, banning,
//      the registrations switch, concurrent callbacks, tokens encrypted at rest
// Legacy mode (no OIDC_* variables) is covered, unchanged, by auth-guard.test.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawn } = require('node:child_process');
const { io: ioClient } = require('socket.io-client');
const { startFakeIssuer } = require('./fakeOidcIssuer');
const { SECRET, cookieFor, adminCookie, startServer, centralSessionCookie, freePort } = require('./testServer');
const { readOidcConfig, OidcConfigError } = require('./oidcConfig');
const secretBox = require('./secretBox');
const { parseUpstream } = require('./oidcLink');
const { parseRegistrationsDefault, createSettings } = require('./settings');
const { createOidcSessions } = require('./oidcSessions');
const userAuthMod = require('./userAuth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers

function setCookie(res, name) {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(';');
    const idx = pair.indexOf('=');
    if (pair.slice(0, idx).trim() !== name) continue;
    return { value: pair.slice(idx + 1), attrs: attrs.map((a) => a.trim()), raw: c };
  }
  return null;
}

const get = (url, cookie, extra = {}) => fetch(url, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...extra } });

/** The three legs of a browser sign-in, separately so tests can tamper with each. */
async function begin(base, { next, cookie } = {}) {
  const res = await get(`${base}/auth/oidc/login${next !== undefined ? `?next=${encodeURIComponent(next)}` : ''}`, cookie);
  assert.equal(res.status, 302, 'login redirects to the IdP');
  const flow = setCookie(res, 'la_oidc_flow');
  return { authorizeUrl: res.headers.get('location'), flow: flow && `la_oidc_flow=${flow.value}`, flowCookie: flow };
}
async function authorize(idp, authorizeUrl, claims) {
  idp.user = claims;
  const res = await get(authorizeUrl);
  assert.equal(res.status, 302);
  return res.headers.get('location');
}
async function finish(callbackUrl, cookies = []) {
  const res = await get(callbackUrl, cookies.filter(Boolean).join('; '));
  const s = setCookie(res, 'la_session');
  return { res, status: res.status, location: res.headers.get('location'), session: s && s.value ? `la_session=${s.value}` : null, sessionCookie: s };
}
async function signIn(base, idp, claims, { next, cookie } = {}) {
  const b = await begin(base, { next });
  const cb = await authorize(idp, b.authorizeUrl, claims);
  return finish(cb, [b.flow, cookie]);
}

function socketFor(base, cookie) {
  const s = ioClient(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: cookie ? { cookie } : {} });
  const ready = new Promise((resolve, reject) => { s.on('connect', () => resolve(s)); s.on('connect_error', reject); });
  return { socket: s, ready, gone: new Promise((resolve) => s.on('disconnect', resolve)) };
}

const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timed out: ${what}`); })]);

function centralEnv(idp, extra = {}) {
  return (port) => ({
    OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'listen-along', BASE_URL: `http://127.0.0.1:${port}`,
    AUTH_RATE_LIMIT: '10000', ...extra,
  });
}

/** Spawn the server expecting it to exit; resolves { code, log }. */
function runUntilExit(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: { ...process.env, PORT: '0', SESSION_SECRET: SECRET, NODE_ENV: 'test', ...env, DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    proc.stdout.on('data', (d) => { log += d; if (/Server running on port/.test(log)) proc.kill('SIGKILL'); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code) => resolve({ code, log }));
    setTimeout(() => proc.kill('SIGKILL'), 20_000);
  });
}

// ---------------------------------------------------------------- 1. units

describe('central login: rules', () => {
  const env = { OIDC_ISSUER: 'https://id.example.com/application/o/listen-along/', OIDC_CLIENT_ID: 'listen-along', BASE_URL: 'https://music.example.com', SESSION_SECRET: 's' };

  it('configuration: off, on, half-configured and unusable values', () => {
    assert.deepEqual(readOidcConfig({}), { enabled: false });
    assert.deepEqual(readOidcConfig({ OIDC_ISSUER: '  ', OIDC_CLIENT_ID: '' }), { enabled: false });
    const cfg = readOidcConfig(env);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.redirectUri, 'https://music.example.com/auth/oidc/callback');
    assert.equal(cfg.postLogoutRedirectUri, 'https://music.example.com/');
    assert.equal(cfg.scopes, 'openid email profile entitlements offline_access');
    assert.equal(cfg.recheckMs, 300_000);
    assert.equal(cfg.maxUnverifiedMs, 86_400_000);
    assert.deepEqual(cfg.providerMap, { google: 'google', github: 'github' });
    assert.equal(cfg.upstreamExpected, false);
    assert.equal(readOidcConfig({ ...env, OIDC_SCOPES: 'openid upstream' }).upstreamExpected, true);
    // Plain names on http (dev, tests); __Host- names whenever Secure (production).
    assert.equal(cfg.secureCookies, false);
    assert.equal(cfg.sessionCookie, 'la_session');
    assert.equal(cfg.flowCookie, 'la_oidc_flow');
    const prod = readOidcConfig({ ...env, NODE_ENV: 'production' });
    assert.equal(prod.secureCookies, true);
    assert.equal(prod.sessionCookie, '__Host-la_session');
    assert.equal(prod.flowCookie, '__Host-la_oidc_flow');
    assert.equal(readOidcConfig({ ...env, BASE_URL: 'https://music.example.com/' }).redirectUri, 'https://music.example.com/auth/oidc/callback');
    assert.equal(readOidcConfig({ ...env, BASE_URL: '', FRONTEND_URL: 'https://f.example.com' }).redirectUri, 'https://f.example.com/auth/oidc/callback');
    assert.equal(readOidcConfig({ ...env, OIDC_SCOPES: 'openid email upstream' }).scopes, 'openid email upstream');
    assert.deepEqual(readOidcConfig({ ...env, OIDC_PROVIDER_MAP: 'gh=github, GOOGLE-OAUTH=google' }).providerMap,
      { google: 'google', github: 'github', gh: 'github', 'google-oauth': 'google' });
    const bad = [
      { OIDC_ISSUER: env.OIDC_ISSUER },
      { OIDC_CLIENT_ID: 'listen-along' },
      { ...env, OIDC_ISSUER: 'not a url' },
      { ...env, OIDC_ISSUER: 'ftp://id.example.com/' },
      { ...env, SESSION_SECRET: '' },
      { ...env, BASE_URL: '', FRONTEND_URL: '' },
      { ...env, BASE_URL: 'https://music.example.com/?x=1' },
      { ...env, OIDC_SCOPES: 'email profile' },
      { ...env, OIDC_PROVIDER_MAP: 'google' },
      { ...env, OIDC_RECHECK_SECONDS: '-5' },
      { ...env, NODE_ENV: 'production', OIDC_ISSUER: 'http://id.example.com/' },
      { ...env, NODE_ENV: 'production', BASE_URL: 'http://music.example.com' },
    ];
    for (const e of bad) assert.throws(() => readOidcConfig(e), OidcConfigError, JSON.stringify(e));
    assert.equal(readOidcConfig({ ...env, OIDC_ISSUER: 'http://id.localhost:39100/application/o/listen-along/' }).allowInsecure, true);
  });

  it('secret boxes open only with the same key and context', () => {
    const k = secretBox.deriveKey('secret', 'purpose-a');
    const box = secretBox.seal(k, 'refresh-token-value', 'row-1');
    assert.doesNotMatch(box, /refresh-token-value/);
    assert.equal(secretBox.open(k, box, 'row-1'), 'refresh-token-value');
    assert.equal(secretBox.open(k, box, 'row-2'), null, 'bound to its row');
    assert.equal(secretBox.open(secretBox.deriveKey('secret', 'purpose-b'), box, 'row-1'), null, 'bound to its purpose');
    assert.equal(secretBox.open(secretBox.deriveKey('other', 'purpose-a'), box, 'row-1'), null, 'bound to the secret');
    const parts = box.split('.');
    parts[2] = Buffer.from('x'.repeat(19)).toString('base64url');
    assert.equal(secretBox.open(k, parts.join('.'), 'row-1'), null, 'tampering is detected');
    assert.notEqual(secretBox.seal(k, 'same', 'r'), secretBox.seal(k, 'same', 'r'), 'random IV');
  });

  it('upstream_identities: mapped providers only, ids as strings, junk ignored', () => {
    const map = { google: 'google', github: 'github', gh: 'github' };
    assert.deepEqual(parseUpstream(undefined, map), []);
    assert.deepEqual(parseUpstream('google:1', map), []);
    assert.deepEqual(parseUpstream([
      { provider: 'google', id: '1234' }, { provider: 'GitHub', id: 987 }, { provider: 'gh', id: '987' },
      { provider: 'discord', id: '5' }, { provider: 'google' }, null, 'x', { provider: 'google', id: { a: 1 } },
      { provider: 'github', id: -1 }, { provider: 'google', id: '' },
    ], map), [{ provider: 'google', providerId: '1234' }, { provider: 'github', providerId: '987' }]);
  });

  it('userAuth in central-login mode never reads the old cookie', async () => {
    const sessions = { resolveHeaders: async (h) => (h.cookie === 'la_session=ok' ? { userId: 'u1', idHash: 'h1' } : null) };
    const ua = userAuthMod.createUserAuth({ secret: SECRET, db: { isAvailable: () => false }, sessions });
    const legacy = cookieFor('u2');
    assert.equal(ua.centralMode, true);
    assert.equal(ua.userIdFromHeaders({ cookie: legacy }), null);
    assert.equal(await ua.resolve({ cookie: legacy }), null);
    assert.deepEqual(await ua.resolve({ cookie: 'la_session=ok' }), { userId: 'u1', sessionId: 'h1' });
    assert.equal(ua.legacyUserIdFromHeaders, undefined, 'nothing exposes the old cookie in this mode');
    const req = { headers: { cookie: legacy } };
    assert.deepEqual(await ua.identify(req), { userId: null, account: null, sessionId: null });
    // Legacy mode is unchanged.
    const legacyUa = userAuthMod.createUserAuth({ secret: SECRET, db: { isAvailable: () => false } });
    assert.equal(legacyUa.centralMode, false);
    assert.equal(legacyUa.userIdFromHeaders({ cookie: legacy }), 'u2');
    assert.deepEqual(await legacyUa.resolve({ cookie: legacy }), { userId: 'u2', sessionId: null });
  });

  it('sessions read only their own cookie name (__Host- in production)', async () => {
    const seen = [];
    const store = { get: async (h) => { seen.push(h); return null; } };
    const cfg = { recheckMs: 1000, maxUnverifiedMs: 5000 };
    const s = createOidcSessions({ store, client: {}, cfg, cookieName: '__Host-la_session' });
    const raw = crypto.randomBytes(32).toString('base64url');
    assert.equal(s.idHashFromHeaders({ cookie: `la_session=${raw}` }), null, 'the unprefixed name is ignored when Secure');
    assert.ok(s.idHashFromHeaders({ cookie: `__Host-la_session=${raw}` }));
  });

  it('REGISTRATIONS_DEFAULT: open by default, closed on request, junk refused; a saved value wins', async () => {
    assert.equal(parseRegistrationsDefault({}), true);
    assert.equal(parseRegistrationsDefault({ REGISTRATIONS_DEFAULT: '' }), true);
    assert.equal(parseRegistrationsDefault({ REGISTRATIONS_DEFAULT: 'open' }), true);
    assert.equal(parseRegistrationsDefault({ REGISTRATIONS_DEFAULT: ' Closed ' }), false);
    for (const bad of ['no', 'false', '0', 'off']) assert.throws(() => parseRegistrationsDefault({ REGISTRATIONS_DEFAULT: bad }));
    const noDb = { isAvailable: () => false };
    const closed = createSettings({ db: noDb, defaults: { registrations_open: false } });
    assert.deepEqual(await closed.read('registrations_open'), { value: false, source: 'default' });
    await closed.set('registrations_open', true);
    assert.deepEqual(await closed.read('registrations_open'), { value: true, source: 'saved' });
    const open = createSettings({ db: noDb, defaults: { registrations_open: true } });
    await open.set('registrations_open', false);
    assert.equal(await open.registrationsOpen(), false, 'saved closed beats env open');
    const expected = createSettings({ db: noDb, dbExpected: true });
    await assert.rejects(expected.registrationsOpen(), /unavailable/, 'no silent default when the database is missing');
  });

  it('the route policy knows the central login round trip', () => {
    for (const p of ['/auth/oidc/login', '/auth/oidc/callback']) assert.equal(userAuthMod.policyFor(p), 'public', p);
    assert.equal(userAuthMod.policyFor('/api/admin/settings'), 'self');
  });
});

describe('central login off: the legacy app is unchanged', { timeout: 60_000 }, () => {
  it('no OIDC routes, the same providers answer, logout as before', async () => {
    const srv = await startServer({ GOOGLE_CLIENT_ID: 'test-google-client' });
    try {
      for (const p of ['/auth/oidc/login', '/auth/oidc/callback?code=x&state=y']) assert.equal((await get(srv.base + p)).status, 404, p);
      assert.deepEqual(await (await get(`${srv.base}/api/auth/providers`)).json(), { google: true, github: false });
      assert.match((await get(`${srv.base}/auth/google`)).headers.get('location'), /^https:\/\/accounts\.google\.com\//);
      const out = await fetch(`${srv.base}/api/auth/logout`, { method: 'POST', headers: { cookie: cookieFor('x') } });
      assert.deepEqual(await out.json(), { success: true });
      assert.equal((await get(`${srv.base}/api/playlists`, cookieFor('00000000-0000-4000-8000-0000000000ab'))).status, 200, 'listen_auth is the login');
      assert.deepEqual(await (await get(`${srv.base}/api/admin/settings`, adminCookie())).json(), { registrations_open: true, source: 'default', central_login: false });
      assert.doesNotMatch(srv.log(), /\[oidc\]/);
    } finally { await srv.stop(); }
  });
});

// ---------------------------------------------------------------- 2. boot

describe('central login: boot', { timeout: 60_000 }, () => {
  it('a bad REGISTRATIONS_DEFAULT refuses to start', async () => {
    const r = await runUntilExit({ REGISTRATIONS_DEFAULT: 'maybe' });
    assert.equal(r.code, 1);
    assert.match(r.log, /REGISTRATIONS_DEFAULT must be "open" or "closed"/);
  });

  it('DATABASE_URL set but the database down: sign-in fails closed, nothing in memory', async () => {
    const idp = await startFakeIssuer();
    const deadPort = await freePort();
    const srv = await startServer(centralEnv(idp, { DATABASE_URL: `postgres://x:y@127.0.0.1:${deadPort}/none` }));
    try {
      const s = await signIn(srv.base, idp, { sub: 'dbdown-1', email: 'd@example.com', email_verified: true });
      assert.equal(s.location, '/login?error=signin_unavailable');
      assert.equal(s.session, null);
      assert.match(srv.log(), /database is unavailable/);
      assert.equal((await get(`${srv.base}/api/playlists`, `la_session=${crypto.randomBytes(32).toString('base64url')}`)).status, 503, 'session lookups fail closed');
      assert.equal((await get(`${srv.base}/api/admin/settings`, adminCookie())).status, 500);
    } finally {
      await srv.stop();
      await idp.close();
    }
  });

  it('a half configuration refuses to start, with the reason', async () => {
    const r = await runUntilExit({ OIDC_ISSUER: 'http://127.0.0.1:9/application/o/listen-along/' });
    assert.equal(r.code, 1);
    assert.match(r.log, /half-configured.*OIDC_CLIENT_ID/);
  });

  it('metadata from the wrong issuer refuses to start', async () => {
    const idp = await startFakeIssuer();
    try {
      idp.metadataOverride = (md) => ({ ...md, issuer: 'http://evil.example/' });
      const r = await runUntilExit({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'listen-along', BASE_URL: 'http://127.0.0.1:1' });
      assert.equal(r.code, 1);
      assert.match(r.log, /discovery .* failed/);
      idp.metadataOverride = (md) => ({ ...md, code_challenge_methods_supported: ['plain'] });
      const r2 = await runUntilExit({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'listen-along', BASE_URL: 'http://127.0.0.1:1' });
      assert.equal(r2.code, 1);
      assert.match(r2.log, /S256/);
    } finally { await idp.close(); }
  });

  it('an IdP that is down at boot does not stop the server; sign-in works once it is up', async () => {
    const idpPort = await freePort();
    const issuer = `http://127.0.0.1:${idpPort}/application/o/listen-along/`;
    const srv = await startServer((port) => ({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'listen-along', BASE_URL: `http://127.0.0.1:${port}`, AUTH_RATE_LIMIT: '1000' }));
    let idp;
    try {
      assert.match(srv.log(), /not reachable at boot/);
      assert.equal((await get(`${srv.base}/health`)).status, 200);
      const r = await get(`${srv.base}/auth/oidc/login`);
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/login?error=signin_unavailable');
      idp = await startFakeIssuer({ port: idpPort });
      const s = await signIn(srv.base, idp, { sub: 'late-1', email: 'late@example.com', email_verified: true });
      assert.equal(s.location, '/');
      assert.ok(s.session);
    } finally {
      await srv.stop();
      if (idp) await idp.close();
    }
  });
});

// ---------------------------------------------------------------- 3. protocol (no database)

describe('central login: protocol, sessions and re-check (no database)', { timeout: 120_000 }, () => {
  let idp;
  let srv;
  const sockets = [];

  before(async () => {
    idp = await startFakeIssuer();
    srv = await startServer(centralEnv(idp, { OIDC_RECHECK_SECONDS: '1', OIDC_MAX_UNVERIFIED_SECONDS: '4' }));
  });
  after(async () => {
    for (const s of sockets) s.disconnect();
    if (srv) await srv.stop();
    if (idp) await idp.close();
  });
  const sock = (cookie) => { const h = socketFor(srv.base, cookie); sockets.push(h.socket); return h; };

  it('happy path: PKCE S256 + state + nonce, fixed redirect URI, an opaque HttpOnly session cookie', async () => {
    const b = await begin(srv.base, { next: '/library?q=x' });
    const a = new URL(b.authorizeUrl);
    assert.equal(a.origin + a.pathname, `${idp.origin}/application/o/authorize/`);
    const q = a.searchParams;
    assert.equal(q.get('client_id'), 'listen-along');
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(q.get('state') && q.get('nonce'));
    assert.equal(q.get('redirect_uri'), `${srv.base}/auth/oidc/callback`);
    assert.equal(q.get('scope'), 'openid email profile entitlements offline_access');
    const fc = b.flowCookie;
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert.ok(fc.attrs.includes(attr), attr);
    assert.ok(!fc.attrs.some((a) => /^Domain=/i.test(a)), 'host-only');
    assert.doesNotMatch(fc.value, new RegExp(q.get('state')), 'the flow cookie is encrypted');

    const cb = await authorize(idp, b.authorizeUrl, { sub: 'happy-1', email: 'happy@example.com', email_verified: true, name: 'Happy' });
    const f = await finish(cb, [b.flow]);
    assert.equal(f.status, 302);
    assert.equal(f.location, '/library?q=x');
    assert.ok(f.session);
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(f.sessionCookie.attrs.includes(attr), attr);
    assert.ok(f.sessionCookie.attrs.some((a) => /^Max-Age=2592000$/.test(a)), '30 days');
    assert.match(f.sessionCookie.value, /^[A-Za-z0-9_-]{43}$/, 'opaque random id, nothing inside');
    assert.ok(setCookie(f.res, 'la_oidc_flow').attrs.some((a) => /Expires=Thu, 01 Jan 1970/.test(a)), 'flow cookie cleared');

    assert.equal((await get(`${srv.base}/api/playlists`, f.session)).status, 200);
    assert.equal((await get(`${srv.base}/library`, f.session)).status, 200);
    assert.equal((await get(`${srv.base}/login?next=%2Flibrary`, f.session)).headers.get('location'), '/library');
    const s = sock(f.session);
    await within(s.ready, 3000, 'socket connects with the session');
  });

  it('signing in again replaces the browser\'s previous session; the code is not logged', async () => {
    const first = await signIn(srv.base, idp, { sub: 'again-1' });
    const second = await signIn(srv.base, idp, { sub: 'again-2' }, { cookie: first.session });
    assert.ok(second.session);
    assert.equal((await get(`${srv.base}/api/playlists`, first.session)).status, 401, 'the old session is gone');
    assert.equal((await get(`${srv.base}/api/playlists`, second.session)).status, 200);
    assert.doesNotMatch(srv.log(), /\/auth\/oidc\/callback\?code=/);
  });

  it('the redirect URI comes from BASE_URL, never the Host header', async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(`${srv.base}/auth/oidc/login`, { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } }, resolve).on('error', reject);
    });
    res.resume();
    assert.equal(new URL(res.headers.location).searchParams.get('redirect_uri'), `${srv.base}/auth/oidc/callback`);
  });

  it('?next must be a same-origin path', async () => {
    for (const evil of ['//evil.example/x', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const s = await signIn(srv.base, idp, { sub: 'next-1' }, { next: evil });
      assert.equal(s.location, '/', evil);
    }
  });

  it('rejects every validation failure with the generic error and no session', async () => {
    const claims = { sub: 'victim-1', email: 'v@example.com', email_verified: true };
    const failed = (f, what) => {
      assert.equal(f.status, 302, what);
      assert.equal(f.location, '/login?error=signin_failed', what);
      assert.equal(f.session, null, what);
    };
    // state
    let b = await begin(srv.base);
    let cb = new URL(await authorize(idp, b.authorizeUrl, claims));
    cb.searchParams.set('state', 'forged');
    failed(await finish(cb.href, [b.flow]), 'state');
    // id_token claims and signature (one-shot tamper of the next id_token)
    for (const [what, tamper] of [
      ['nonce', { nonce: 'not-the-one' }], ['audience', { aud: 'someone-else' }], ['issuer', { iss: 'http://evil.example/' }],
      ['expired', { exp: Math.floor(Date.now() / 1000) - 600 }], ['signature', { key: 'other' }],
      ['alg none', { alg: 'none' }], ['HS256', { alg: 'HS256' }],
      ['extra audience', { aud: ['listen-along', 'someone-else'], azp: 'listen-along' }],
      ['extra audience, no azp', { aud: ['listen-along', 'someone-else'] }],
      ['wrong azp', { azp: 'someone-else' }],
    ]) {
      b = await begin(srv.base);
      cb = await authorize(idp, b.authorizeUrl, claims);
      idp.tamper = tamper;
      failed(await finish(cb, [b.flow]), what);
    }
    // PKCE: a code from one flow injected into another (state made to match)
    const victim = await begin(srv.base);
    const attacker = await begin(srv.base);
    const attackerCb = new URL(await authorize(idp, attacker.authorizeUrl, claims));
    attackerCb.searchParams.set('state', new URL(victim.authorizeUrl).searchParams.get('state'));
    idp.lastTokenError = null;
    failed(await finish(attackerCb.href, [victim.flow]), 'pkce');
    assert.equal(idp.lastTokenError, 'PKCE verification failed', 'it got as far as the token endpoint');
    // the flow cookie: expired (re-sealed with the server's key, 11 minutes old)
    b = await begin(srv.base);
    cb = await authorize(idp, b.authorizeUrl, claims);
    const flowKey = secretBox.deriveKey(SECRET, 'oidc-flow-cookie-v1');
    const flowData = JSON.parse(secretBox.open(flowKey, decodeURIComponent(b.flowCookie.value), 'listen-along/oidc-flow'));
    flowData.t = Date.now() - 11 * 60 * 1000;
    failed(await finish(cb, [`la_oidc_flow=${secretBox.seal(flowKey, JSON.stringify(flowData), 'listen-along/oidc-flow')}`]), 'expired flow cookie');
    // the flow cookie: missing, forged, from another secret
    b = await begin(srv.base);
    cb = await authorize(idp, b.authorizeUrl, claims);
    failed(await finish(cb, []), 'no flow cookie');
    b = await begin(srv.base);
    cb = await authorize(idp, b.authorizeUrl, claims);
    failed(await finish(cb, ['la_oidc_flow=v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA']), 'forged flow cookie');
    // a callback replayed (the code works once)
    b = await begin(srv.base);
    cb = await authorize(idp, b.authorizeUrl, claims);
    assert.ok((await finish(cb, [b.flow])).session);
    failed(await finish(cb, [b.flow]), 'replayed code');
    // the IdP says no
    b = await begin(srv.base);
    cb = await authorize(idp, b.authorizeUrl, null);
    assert.match(cb, /error=access_denied/);
    failed(await finish(cb, [b.flow]), 'access_denied');
  });

  it('the old listen_auth cookie is never a session in this mode', async () => {
    const old = cookieFor('00000000-0000-4000-8000-0000000000aa');
    assert.equal((await get(`${srv.base}/api/playlists`, old)).status, 401);
    assert.equal((await get(`${srv.base}/api/profile`, old)).status, 401);
    assert.equal((await get(`${srv.base}/`, old)).headers.get('location'), '/login');
    assert.equal((await get(`${srv.base}/login`, old)).status, 200, 'no redirect: not signed in');
    assert.deepEqual(await (await get(`${srv.base}/api/auth/me`, old)).json(), { authenticated: false });
    await assert.rejects(sock(old).ready, /Authentication required/);
    // ...and the callback drops it.
    const s = await signIn(srv.base, idp, { sub: 'drop-old' }, { cookie: old });
    assert.ok(setCookie(s.res, 'listen_auth').attrs.some((a) => /Expires=Thu, 01 Jan 1970/.test(a)));
  });

  it('Google / GitHub sign-in and linking are gone; providers say central', async () => {
    for (const p of ['/auth/google', '/auth/google/callback', '/auth/github', '/auth/github/callback',
      '/auth/google/link', '/auth/google/link/callback', '/auth/github/link', '/auth/github/link/callback']) {
      assert.equal((await get(srv.base + p)).status, 404, p);
    }
    assert.deepEqual(await (await get(`${srv.base}/api/auth/providers`)).json(), { google: false, github: false, central: true });
    const s = await signIn(srv.base, idp, { sub: 'unlink-1' });
    assert.equal((await fetch(`${srv.base}/api/profile/providers/github`, { method: 'DELETE', headers: { cookie: s.session } })).status, 404);
  });

  it('a garbage la_session cookie is no login', async () => {
    for (const bad of ['la_session=x', `la_session=${'A'.repeat(43)}`, `la_session=${crypto.randomBytes(32).toString('base64url')}`]) {
      assert.equal((await get(`${srv.base}/api/playlists`, bad)).status, 401, bad);
    }
  });

  it('re-check: refresh succeeds, the rotated refresh token is kept', async () => {
    const s = await signIn(srv.base, idp, { sub: 'refresh-1' });
    const before = idp.calls.refresh;
    await sleep(1100);
    assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 200);
    assert.equal(idp.calls.refresh, before + 1);
    await sleep(1100);
    // The fake refuses a used refresh token: this only passes with the new one.
    assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 200);
    assert.equal(idp.calls.refresh, before + 2);
  });

  it('re-check is single-flight per session', async () => {
    const s = await signIn(srv.base, idp, { sub: 'flight-1' });
    await sleep(1100);
    idp.refreshDelayMs = 300;
    const before = idp.calls.refresh;
    const statuses = await Promise.all(Array.from({ length: 6 }, () => get(`${srv.base}/api/playlists`, s.session).then((r) => r.status)));
    idp.refreshDelayMs = 0;
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200]);
    assert.equal(idp.calls.refresh, before + 1);
  });

  it('invalid_grant (disabled centrally) ends the session and cuts its sockets', async () => {
    const s = await signIn(srv.base, idp, { sub: 'disabled-1' });
    const h = sock(s.session);
    await within(h.ready, 3000, 'socket');
    idp.disable('disabled-1');
    await sleep(1100);
    assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 401);
    await within(h.gone, 3000, 'socket cut');
    assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 401, 'stays ended');
    idp.enable('disabled-1');
  });

  it('a long-lived socket is re-checked on a timer', async () => {
    const s = await signIn(srv.base, idp, { sub: 'socket-timer-1' });
    const h = sock(s.session);
    await within(h.ready, 3000, 'socket');
    idp.disable('socket-timer-1');
    await within(h.gone, 9000, 'socket cut by the timer, without any HTTP request');
    idp.enable('socket-timer-1');
  });

  it('re-check: a refreshed id_token that does not validate, or names someone else, ends the session', async () => {
    for (const [what, tamper] of [['bad signature', { key: 'other' }], ['other sub', { sub: 'someone-else' }], ['alg none', { alg: 'none' }]]) {
      const sub = `refresh-tamper-${what.replace(/\W/g, '')}`;
      const s = await signIn(srv.base, idp, { sub });
      await sleep(1100);
      idp.tamper = { ...tamper, forSub: sub };
      assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 401, what);
    }
  });

  it('re-check: an OAuth error other than invalid_grant (invalid_client) keeps the session and logs loudly', async () => {
    const s = await signIn(srv.base, idp, { sub: 'misconfig-1' });
    await sleep(1100);
    idp.refreshError = 'invalid_client';
    try {
      assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 200);
      assert.match(srv.log(), /CONFIGURATION PROBLEM: the IdP rejected the refresh with 401 invalid_client/);
    } finally { idp.refreshError = null; }
    await sleep(1100);
  });

  it('IdP down (5xx or no answer) keeps the session, until the unverified cap', async () => {
    const s = await signIn(srv.base, idp, { sub: 'outage-1' });
    const t0 = Date.now();
    idp.down = 'reset';
    await sleep(1100);
    assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 200, 'connection reset: kept');
    const s2 = await signIn(srv.base, idp, { sub: 'outage-2' }).catch(() => null);
    assert.equal(s2 && s2.location, '/login?error=signin_unavailable', 'a new sign-in cannot finish meanwhile');
    idp.down = 'http503';
    const tokenCalls = idp.calls.token;
    const t1 = Date.now();
    assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 200, '503: kept');
    assert.ok(Date.now() - t1 < 1000, 'no stall: the failed session is not retried at once');
    assert.equal(idp.calls.token, tokenCalls, 'backed off, no new refresh attempt');
    // OIDC_MAX_UNVERIFIED_SECONDS=4: after that without a successful check it ends.
    await sleep(Math.max(0, 4300 - (Date.now() - t0)));
    assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 401, 'fail closed after the cap');
    idp.down = false;
  });

  it('logout: session and sockets gone, then the IdP end-session URL with id_token_hint', async () => {
    const s = await signIn(srv.base, idp, { sub: 'logout-1' });
    const h = sock(s.session);
    await within(h.ready, 3000, 'socket');
    const r = await fetch(`${srv.base}/api/auth/logout`, { method: 'POST', headers: { cookie: s.session } });
    assert.equal(r.status, 200);
    const body = await r.json();
    const u = new URL(body.redirect);
    assert.equal(u.origin + u.pathname, `${idp.issuer}end-session/`);
    assert.equal(u.searchParams.get('post_logout_redirect_uri'), `${srv.base}/`);
    assert.equal(u.searchParams.get('client_id'), 'listen-along');
    assert.equal(u.searchParams.get('id_token_hint').split('.').length, 3);
    assert.ok(setCookie(r, 'la_session').attrs.some((a) => /Expires=Thu, 01 Jan 1970/.test(a)));
    await within(h.gone, 3000, 'socket cut on logout');
    assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 401);
    const back = await get(body.redirect);
    assert.equal(back.headers.get('location'), `${srv.base}/`);
    // Without a session: nothing to end.
    const anon = await (await fetch(`${srv.base}/api/auth/logout`, { method: 'POST' })).json();
    assert.deepEqual(anon, { success: true, redirect: '/' });
  });

  it('registrations closed (in memory without a database): no new account', async () => {
    const admin = adminCookie();
    const put = (v, cookie) => fetch(`${srv.base}/api/admin/settings`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ registrations_open: v }) });
    assert.equal((await put(false, admin)).status, 200);
    const s = await signIn(srv.base, idp, { sub: 'closed-1' });
    assert.equal(s.location, '/login?error=registrations_closed');
    assert.equal(s.session, null);
    assert.equal((await put(true, admin)).status, 200);
    assert.ok((await signIn(srv.base, idp, { sub: 'closed-1' })).session);
  });
});

describe('central login: the sign-in routes are rate limited', { timeout: 60_000 }, () => {
  it('per client address', async () => {
    const idp = await startFakeIssuer();
    const srv = await startServer(centralEnv(idp, { AUTH_RATE_LIMIT: '3' }));
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await get(`${srv.base}/auth/oidc/login`)).status);
      assert.deepEqual(codes, [302, 302, 302, 429]);
      assert.equal((await get(`${srv.base}/auth/oidc/callback?code=x&state=y`)).status, 429);
    } finally {
      await srv.stop();
      await idp.close();
    }
  });
});

// ---------------------------------------------------------------- 4. on Postgres

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const pgSkip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('central login on Postgres: linking, banning, registrations', { skip: pgSkip, timeout: 240_000 }, () => {
  let container;
  let pg;
  let idp;
  let srv;
  let tmp;
  let pgUrl;
  const sockets = [];
  const U = {};
  // Central mode as the owner deploys it first: registrations closed until an
  // admin saves the switch, and `upstream` requested.
  const pgEnv = (extra = {}) => centralEnv(idp, {
    DATABASE_URL: pgUrl, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'),
    APP_RELEASES_API_URL: 'http://127.0.0.1:9/', REGISTRATIONS_DEFAULT: 'closed',
    OIDC_SCOPES: 'openid email profile entitlements offline_access upstream', ...extra,
  });

  const addUser = async (key, { provider = 'google', providerId = key, email = null, name = `Legacy ${key}`, displayName = null, status = 'approved', createdAt, providers = [] } = {}) => {
    const r = await pg.query(
      `INSERT INTO users (provider, provider_id, email, name, display_name, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [provider, providerId, email, name, displayName, status, createdAt]
    );
    U[key] = r.rows[0].id;
    for (const p of [{ provider, providerId, email }, ...providers]) {
      if (!p.provider || p.provider === 'local') continue;
      await pg.query(
        `INSERT INTO user_providers (user_id, provider, provider_id, email, name, linked_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [U[key], p.provider, p.providerId, p.email || null, name, createdAt]
      );
    }
    return U[key];
  };
  const userRow = async (id) => (await pg.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
  const bySub = async (sub) => (await pg.query('SELECT * FROM users WHERE oidc_sub = $1', [sub])).rows;
  const userCount = async () => (await pg.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  const me = async (cookie) => (await get(`${srv.base}/api/auth/me`, cookie)).json();

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('listen_oidc').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-oidc-test-'));
    idp = await startFakeIssuer();
    pgUrl = url;
    srv = await startServer(pgEnv());
    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();

    await addUser('google1', { provider: 'google', providerId: 'g-1', email: 'one@example.com', createdAt: 1000 });
    // Two legacy accounts for one person (one per provider): ambiguous upstream.
    await addUser('ambOld', { provider: 'github', providerId: '222', createdAt: 2000 });
    await addUser('ambNew', { provider: 'google', providerId: 'g-2', createdAt: 3000 });
    await addUser('email3', { provider: 'google', providerId: 'g-3', email: 'Three@Example.com', createdAt: 4000 });
    // A legacy GitHub account holding someone else's address (GitHub need not have verified it).
    await addUser('ghVictim', { provider: 'github', providerId: '777', email: 'victim@example.com', createdAt: 4500 });
    // The same address on two accounts (users.email / user_providers.email).
    await addUser('dupA', { provider: 'google', providerId: 'g-4a', email: 'dup@example.com', createdAt: 5000 });
    await addUser('dupB', { provider: 'github', providerId: '444', email: null, createdAt: 6000, providers: [{ provider: 'google', providerId: 'g-4b', email: 'DUP@example.com' }] });
    await addUser('cookie5', { provider: 'github', providerId: '555', createdAt: 7000 });
    await addUser('denied6', { provider: 'google', providerId: 'g-6', status: 'denied', createdAt: 8000 });
    await addUser('named7', { provider: 'google', providerId: 'g-7', name: 'Provider Name', displayName: 'Chosen Name', createdAt: 9000 });
    await addUser('same8', { provider: 'google', providerId: 'g-8', name: 'Old Name', displayName: 'Old Name', createdAt: 9100 });
    await addUser('ban9', { provider: 'google', providerId: 'g-9', createdAt: 9200 });
    await addUser('race10', { provider: 'google', providerId: 'g-10', createdAt: 9300 });
    await addUser('early14', { provider: 'google', providerId: 'g-14', createdAt: 9350 });
    // Legacy-only provider (users columns, no user_providers row).
    const r = await pg.query(`INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ('github', '1111', 'Columns Only', 'approved', 9400) RETURNING id`);
    U.columns11 = r.rows[0].id;
  });
  after(async () => {
    for (const s of sockets) s.disconnect();
    if (srv) await srv.stop();
    if (idp) await idp.close();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the schema: oidc_sub (unique), user_sessions, app_settings', async () => {
    const cols = (await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'oidc_sub'`)).rows;
    assert.equal(cols.length, 1);
    const idx = (await pg.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_users_oidc_sub'`)).rows[0];
    assert.match(idx.indexdef, /UNIQUE/);
    for (const t of ['user_sessions', 'app_settings']) {
      assert.equal((await pg.query('SELECT to_regclass($1) AS t', [t])).rows[0].t, t);
    }
  });

  it('REGISTRATIONS_DEFAULT=closed, nothing saved: unmatched refused, existing accounts link; a missing upstream claim is flagged', async () => {
    const admin = adminCookie();
    assert.deepEqual(await (await get(`${srv.base}/api/admin/settings`, admin)).json(), { registrations_open: false, source: 'default', central_login: true });
    const before = await userCount();
    const s = await signIn(srv.base, idp, { sub: 'central-nomatch', email: 'nomatch@example.com', email_verified: true });
    assert.equal(s.location, '/login?error=registrations_closed');
    assert.equal(s.session, null);
    assert.equal(await userCount(), before, 'nothing irreversible happened');
    assert.match(srv.log(), /central-login: WARNING the id_token has no upstream_identities/);
    assert.match(srv.log(), /central-login: refused rule=e reason=registrations_closed user=- sub=central-… upstream=MISSING\(#1\)/);
    const ok = await signIn(srv.base, idp, { sub: 'central-14', upstream_identities: [{ provider: 'google', id: 'g-14' }] });
    assert.equal((await me(ok.session)).user.id, U.early14);
    assert.match(srv.log(), new RegExp(`central-login: link rule=b user=${U.early14} linked sub=central-… upstream=1`));
  });

  it('saving the switch in the dashboard overrides the env default (open over closed)', async () => {
    const put = (v) => fetch(`${srv.base}/api/admin/settings`, { method: 'PUT', headers: { cookie: adminCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ registrations_open: v }) });
    assert.equal((await put(true)).status, 200);
    assert.deepEqual(await (await get(`${srv.base}/api/admin/settings`, adminCookie())).json(), { registrations_open: true, source: 'saved', central_login: true });
    const s = await signIn(srv.base, idp, { sub: 'central-nomatch' });
    assert.ok(s.session, 'created now');
    assert.match(srv.log(), /central-login: link rule=e user=[0-9a-f-]+ created/);
  });

  it('rule b: an upstream identity links the legacy account (user_providers)', async () => {
    const s = await signIn(srv.base, idp, { sub: 'central-1', upstream_identities: [{ provider: 'google', id: 'g-1' }], name: 'Central One' });
    assert.equal(s.location, '/');
    const m = await me(s.session);
    assert.equal(m.user.id, U.google1);
    assert.equal((await userRow(U.google1)).oidc_sub, 'central-1');
    assert.equal((await userRow(U.google1)).name, 'Central One', 'no display name of their own: the IdP name is used');
    assert.match(srv.log(), new RegExp(`central-login: link rule=b user=${U.google1} linked`));
  });

  it('rule a: next time by sub, whatever else the token says', async () => {
    const s = await signIn(srv.base, idp, { sub: 'central-1', email: 'dup@example.com', email_verified: true });
    assert.equal((await me(s.session)).user.id, U.google1);
    assert.match(srv.log(), new RegExp(`central-login: link rule=a user=${U.google1} signed-in`));
  });

  it('rule b: upstream accounts of a user already linked elsewhere -> refused, never a new account', async () => {
    const before = await userCount();
    const s = await signIn(srv.base, idp, { sub: 'central-1-impostor', upstream_identities: [{ provider: 'google', id: 'g-1' }], email: 'x@example.com', email_verified: true });
    assert.equal(s.location, '/login?error=link_conflict');
    assert.equal(s.session, null);
    assert.equal(await userCount(), before);
    assert.match(srv.log(), new RegExp(`central-login: REFUSED rule=b sub=central-… link_conflict: .*${U.google1}.*sub central-…`));
  });

  it('rule b: legacy users.provider columns count too; numeric GitHub ids', async () => {
    const s = await signIn(srv.base, idp, { sub: 'central-11', upstream_identities: [{ provider: 'github', id: 1111 }] });
    assert.equal((await me(s.session)).user.id, U.columns11);
  });

  it('rule b: several accounts -> the earliest is linked, the others logged, nothing merged', async () => {
    const before = await userCount();
    const s = await signIn(srv.base, idp, { sub: 'central-amb', upstream_identities: [{ provider: 'google', id: 'g-2' }, { provider: 'github', id: '222' }] });
    assert.equal((await me(s.session)).user.id, U.ambOld);
    assert.equal((await userRow(U.ambNew)).oidc_sub, null, 'the other account is untouched');
    assert.equal(await userCount(), before, 'no rows created or merged');
    assert.match(srv.log(), new RegExp(`merge by hand: ${U.ambNew}`));
  });

  it('rule c: an unverified email never links', async () => {
    const before = await userCount();
    for (const v of [false, 'true', undefined, 1]) {
      const sub = `central-unverified-${String(v)}`;
      const s = await signIn(srv.base, idp, { sub, email: 'three@example.com', email_verified: v });
      const m = await me(s.session);
      assert.notEqual(m.user.id, U.email3, String(v));
      const created = (await bySub(sub))[0];
      assert.equal(created.provider, 'oidc');
      assert.equal(created.email, null, 'an address the IdP did not verify is not stored');
    }
    assert.equal(await userCount(), before + 4);
    assert.equal((await userRow(U.email3)).oidc_sub, null);
  });

  it('rule c: a verified email matching exactly one account links it (case-insensitive)', async () => {
    const s = await signIn(srv.base, idp, { sub: 'central-3', email: 'THREE@example.COM', email_verified: true });
    assert.equal((await me(s.session)).user.id, U.email3);
  });

  it('rule c: only Google-sourced addresses count (a GitHub-only account with that address is not linked)', async () => {
    const s = await signIn(srv.base, idp, { sub: 'central-victim', email: 'victim@example.com', email_verified: true });
    assert.notEqual((await me(s.session)).user.id, U.ghVictim);
    assert.equal((await userRow(U.ghVictim)).oidc_sub, null);
  });

  it('rule c: a verified email matching two accounts links neither', async () => {
    const s = await signIn(srv.base, idp, { sub: 'central-dup', email: 'dup@example.com', email_verified: true });
    const m = await me(s.session);
    assert.ok(![U.dupA, U.dupB].includes(m.user.id));
    assert.equal((await userRow(U.dupA)).oidc_sub, null);
    assert.equal((await userRow(U.dupB)).oidc_sub, null);
    assert.equal((await bySub('central-dup'))[0].email, 'dup@example.com', 'a new account keeps a verified address');
  });

  it('an old login cookie at the callback has no say in linking; it is cleared', async () => {
    const old = cookieFor(U.cookie5);
    assert.equal((await get(`${srv.base}/api/playlists`, old)).status, 401, 'not a session');
    const before = await userCount();
    const s = await signIn(srv.base, idp, { sub: 'central-5' }, { cookie: old });
    const m = await me(s.session);
    assert.notEqual(m.user.id, U.cookie5, 'the cookie did not pick the account');
    assert.equal((await userRow(U.cookie5)).oidc_sub, null);
    assert.equal(await userCount(), before + 1, 'an unmatched identity, with registrations open: a new account');
    assert.ok(setCookie(s.res, 'listen_auth').attrs.some((a) => /Expires=Thu, 01 Jan 1970/.test(a)), 'cleared');
  });

  it('a display name the person chose is kept; a provider-derived one follows the IdP', async () => {
    let s = await signIn(srv.base, idp, { sub: 'central-7', upstream_identities: [{ provider: 'google', id: 'g-7' }], name: 'IdP Name' });
    let row = await userRow(U.named7);
    assert.equal(row.oidc_sub, 'central-7');
    assert.equal(row.display_name, 'Chosen Name');
    assert.equal((await me(s.session)).user.name, 'Chosen Name');
    s = await signIn(srv.base, idp, { sub: 'central-8', upstream_identities: [{ provider: 'google', id: 'g-8' }], name: 'New Name' });
    row = await userRow(U.same8);
    assert.equal(row.display_name, 'New Name');
    assert.equal(row.name, 'New Name');
    assert.equal(row.avatar_url, null);
  });

  it('a denied account is refused (and stays tied to that identity); no new account', async () => {
    const before = await userCount();
    const s = await signIn(srv.base, idp, { sub: 'central-6', upstream_identities: [{ provider: 'google', id: 'g-6' }] });
    assert.equal(s.location, '/login?error=account_disabled');
    assert.equal(s.session, null);
    assert.equal((await userRow(U.denied6)).oidc_sub, 'central-6');
    const again = await signIn(srv.base, idp, { sub: 'central-6' });
    assert.equal(again.location, '/login?error=account_disabled', 'rule a: still refused');
    assert.equal(await userCount(), before);
  });

  it('ban: sessions, sockets and CLI tokens stop at once; unban restores access', async () => {
    const s = await signIn(srv.base, idp, { sub: 'central-9', upstream_identities: [{ provider: 'google', id: 'g-9' }] });
    assert.equal((await me(s.session)).user.id, U.ban9);
    const h = socketFor(srv.base, s.session);
    sockets.push(h.socket);
    await within(h.ready, 3000, 'socket');
    const token = 'la_' + crypto.randomBytes(32).toString('base64url');
    await pg.query('INSERT INTO api_tokens (name, token_hash, token_prefix, user_id) VALUES ($1, $2, $3, $4)',
      ['Laptop', crypto.createHash('sha256').update(token).digest('hex'), token.slice(0, 10), U.ban9]);
    const bearer = { Authorization: `Bearer ${token}` };
    assert.equal((await get(`${srv.base}/api/me`, null, bearer)).status, 200);

    const r = await fetch(`${srv.base}/api/dashboard/users/${U.ban9}/reject`, { method: 'PUT', headers: { cookie: adminCookie() } });
    assert.equal(r.status, 200);
    await within(h.gone, 3000, 'socket cut');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1', [U.ban9])).rows[0].n, 0);
    assert.equal((await get(`${srv.base}/api/playlists`, s.session)).status, 401);
    assert.equal((await get(`${srv.base}/api/me`, null, bearer)).status, 401, 'CLI token stops');
    const back = await signIn(srv.base, idp, { sub: 'central-9' });
    assert.equal(back.location, '/login?error=account_disabled');
    // The other admin route (denied) does the same.
    assert.equal((await fetch(`${srv.base}/api/dashboard/users/${U.ban9}/approve`, { method: 'PUT', headers: { cookie: adminCookie() } })).status, 200);
    const ok = await signIn(srv.base, idp, { sub: 'central-9' });
    assert.ok(ok.session);
    assert.equal((await get(`${srv.base}/api/me`, null, bearer)).status, 200, 'token works again');
    const r2 = await fetch(`${srv.base}/api/auth/users/${U.ban9}/status`, { method: 'POST', headers: { cookie: adminCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ status: 'denied' }) });
    assert.equal(r2.status, 200);
    assert.equal((await get(`${srv.base}/api/playlists`, ok.session)).status, 401);
    await fetch(`${srv.base}/api/dashboard/users/${U.ban9}/approve`, { method: 'PUT', headers: { cookie: adminCookie() } });
  });

  it('the registrations switch: admin only, stored, applied at once, existing users unaffected', async () => {
    const url = `${srv.base}/api/admin/settings`;
    const put = (body, cookie) => fetch(url, { method: 'PUT', headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const userSession = (await signIn(srv.base, idp, { sub: 'central-1' })).session;
    assert.equal((await get(url)).status, 401);
    assert.equal((await get(url, userSession)).status, 401, 'a user session is not the admin');
    assert.equal((await put({ registrations_open: false }, userSession)).status, 401);
    assert.deepEqual(await (await get(url, adminCookie())).json(), { registrations_open: true, source: 'saved', central_login: true });
    assert.equal((await put({ registrations_open: 'no' }, adminCookie())).status, 400);
    assert.equal((await put({ registrations_open: false }, adminCookie())).status, 200);
    assert.deepEqual((await pg.query(`SELECT value FROM app_settings WHERE key = 'registrations_open'`)).rows[0].value, false);

    const before = await userCount();
    const s = await signIn(srv.base, idp, { sub: 'central-new-closed', email: 'nobody@example.com', email_verified: true });
    assert.equal(s.location, '/login?error=registrations_closed');
    assert.equal(s.session, null);
    assert.equal(await userCount(), before, 'nothing created');
    // Existing accounts, linked or still to be linked, still sign in.
    assert.ok((await signIn(srv.base, idp, { sub: 'central-1' })).session);
    const linkNow = await signIn(srv.base, idp, { sub: 'central-10', upstream_identities: [{ provider: 'google', id: 'g-10' }] });
    assert.equal((await me(linkNow.session)).user.id, U.race10);

    assert.equal((await put({ registrations_open: true }, adminCookie())).status, 200);
    const s2 = await signIn(srv.base, idp, { sub: 'central-new-closed' });
    assert.ok(s2.session);
    assert.equal(await userCount(), before + 1);
  });

  it('concurrent callbacks for one new identity make one account', async () => {
    const claims = { sub: 'central-race', email: 'race@example.com', email_verified: true };
    const flows = await Promise.all([0, 1, 2, 3].map(() => begin(srv.base)));
    const cbs = [];
    for (const f of flows) cbs.push(await authorize(idp, f.authorizeUrl, claims));
    const done = await Promise.all(cbs.map((cb, i) => finish(cb, [flows[i].flow])));
    for (const d of done) assert.ok(d.session);
    const rows = await bySub('central-race');
    assert.equal(rows.length, 1);
    const ids = new Set(await Promise.all(done.map(async (d) => (await me(d.session)).user.id)));
    assert.deepEqual([...ids], [rows[0].id]);
  });

  it('two identities racing for one legacy account: one links, the other is refused (link_conflict)', async () => {
    await addUser('race13', { provider: 'google', providerId: 'g-13', createdAt: 9600 });
    const up = [{ provider: 'google', id: 'g-13' }];
    const a = await begin(srv.base);
    const b = await begin(srv.base);
    const cbA = await authorize(idp, a.authorizeUrl, { sub: 'race-a', upstream_identities: up });
    const cbB = await authorize(idp, b.authorizeUrl, { sub: 'race-b', upstream_identities: up });
    const before = await userCount();
    const done = await Promise.all([finish(cbA, [a.flow]), finish(cbB, [b.flow])]);
    const winners = done.filter((d) => d.session);
    assert.equal(winners.length, 1, 'exactly one got in');
    assert.equal((await me(winners[0].session)).user.id, U.race13);
    assert.equal(done.find((d) => !d.session).location, '/login?error=link_conflict');
    assert.ok(['race-a', 'race-b'].includes((await userRow(U.race13)).oidc_sub));
    assert.equal(await userCount(), before, 'no new account for the loser');
  });

  it('sessions at rest: the id is hashed, the tokens encrypted', async () => {
    const s = await signIn(srv.base, idp, { sub: 'central-1' });
    const raw = s.session.split('=')[1];
    const rows = (await pg.query('SELECT * FROM user_sessions')).rows;
    const issued = [...idp.refreshTokens.keys()];
    for (const row of rows) {
      assert.notEqual(row.id_hash, raw);
      for (const col of ['refresh_token_enc', 'id_token_enc']) {
        if (!row[col]) continue;
        assert.match(row[col], /^v1\./);
        for (const t of issued) assert.ok(!row[col].includes(t), 'no refresh token in clear');
        assert.ok(!row[col].includes('eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0'), 'no id_token in clear');
      }
    }
    assert.ok(rows.some((r) => r.id_hash === crypto.createHash('sha256').update(raw).digest('hex')));
  });

  it('dashboard: users carry whether they are linked; centralSessionCookie works like cookieFor', async () => {
    const list = await (await get(`${srv.base}/api/dashboard/users`, adminCookie())).json();
    assert.equal(list.users.find((u) => u.id === U.google1).central, true);
    assert.equal(list.users.find((u) => u.id === U.ambNew).central, false);
    const dev = await centralSessionCookie(pg, U.ambNew);
    assert.equal((await me(dev)).user.id, U.ambNew);
    assert.equal((await get(`${srv.base}/api/playlists`, dev)).status, 200);
    assert.equal((await get(`${srv.base}/api/playlists`, cookieFor(U.ambNew))).status, 401);
  });

  it('restart via legacy mode: the switch is settable there and wins over the env default; no central identity becomes a legacy provider', async () => {
    await srv.stop();
    const legacy = await startServer({
      DATABASE_URL: pgUrl, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'), APP_RELEASES_API_URL: 'http://127.0.0.1:9/',
    });
    try {
      const r = await fetch(`${legacy.base}/api/admin/settings`, { method: 'PUT', headers: { cookie: adminCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ registrations_open: false }) });
      assert.equal(r.status, 200, 'settable while central login is off');
      // That boot ran the user_providers backfill over every user.
      assert.equal((await pg.query(`SELECT count(*)::int AS n FROM user_providers WHERE provider = 'oidc'`)).rows[0].n, 0);
      assert.ok((await pg.query(`SELECT count(*)::int AS n FROM users WHERE provider = 'oidc'`)).rows[0].n > 0);
    } finally { await legacy.stop(); }
    srv = await startServer(pgEnv({ REGISTRATIONS_DEFAULT: 'open' }));
    assert.deepEqual(await (await get(`${srv.base}/api/admin/settings`, adminCookie())).json(), { registrations_open: false, source: 'saved', central_login: true });
    const s = await signIn(srv.base, idp, { sub: 'central-after-restart' });
    assert.equal(s.location, '/login?error=registrations_closed', 'saved closed beats env open from the first central sign-in');
    assert.ok((await signIn(srv.base, idp, { sub: 'central-1' })).session, 'existing accounts unaffected');
  });
});
