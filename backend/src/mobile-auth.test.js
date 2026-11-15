// The Android app's sign-in (mobileAuth.js): the app runs the code + PKCE flow
// in a Custom Tab, the server exchanges the code, links the account and hands
// back an opaque `lam_` session token. Against the fake OpenID provider
// (fakeOidcIssuer.js) and the real server (src/index.js as a child process):
//   1. units: the token shapes, the route policy, CLI-token detection
//   2. the dev sign-in (INSECURE_DEV_LOGIN, no database)
//   3. central login without a database: the protocol and every refusal,
//      re-check, sign-out, web cookies and CLI tokens unaffected, sockets,
//      rate limit, a configured database that is down
//   4. on Postgres: linking rules, pending / denied, registrations closed,
//      bans, the app's API surface, sessions at rest
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { io: ioClient } = require('socket.io-client');
const { startFakeIssuer } = require('./fakeOidcIssuer');
const { SECRET, cookieFor, adminCookie, startServer, freePort } = require('./testServer');
const mobileTokens = require('./mobileTokens');
const { policyFor, refusal } = require('./userAuth');
const tokens = require('./tokens');
const { MOBILE_REDIRECT_URI } = require('./mobileAuth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

const get = (url, headers = {}) => fetch(url, { redirect: 'manual', headers });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}
async function getJson(url, headers) {
  const res = await get(url, headers);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

/** What the app makes before opening the Custom Tab. */
function newFlow() {
  const verifier = rand(32);
  return { verifier, challenge: mobileTokens.s256(verifier), state: rand(16), nonce: rand(16) };
}
const startUrl = (base, f, extra = {}) => `${base}/auth/mobile/start?${new URLSearchParams({
  state: f.state, nonce: f.nonce, code_challenge: f.challenge, code_challenge_method: 'S256', ...extra,
})}`;

/** The browser half against the fake IdP: start -> IdP -> back to the app's scheme. */
async function browse(base, idp, claims, { flow = newFlow(), editAuthorize } = {}) {
  const start = await get(startUrl(base, flow));
  assert.equal(start.status, 302, 'start redirects to the IdP');
  const authorize = new URL(start.headers.get('location'));
  if (editAuthorize) editAuthorize(authorize);
  idp.user = claims;
  const back = await get(authorize.href);
  assert.equal(back.status, 302);
  const redirect = new URL(back.headers.get('location'));
  return { flow, authorize, redirect, code: redirect.searchParams.get('code'), state: redirect.searchParams.get('state') };
}

/** The whole app sign-in; `over` changes the exchange body. */
async function appSignIn(base, idp, claims, { over = {}, headers = {}, editAuthorize } = {}) {
  const b = await browse(base, idp, claims, { editAuthorize });
  assert.equal(b.state, b.flow.state, 'the app gets its own state back');
  const body = { code: b.code, state: b.state, code_verifier: b.flow.verifier, nonce: b.flow.nonce, ...over };
  const r = await post(`${base}/auth/mobile/exchange`, body, headers);
  return { ...r, token: r.body && r.body.token, body: r.body, sent: body, code: b.code };
}

/** A web (browser) sign-in, as central-login.test.js does it. */
async function webSignIn(base, idp, claims) {
  const res = await get(`${base}/auth/oidc/login`);
  const flow = res.headers.getSetCookie().find((c) => c.startsWith('la_oidc_flow=')).split(';')[0];
  idp.user = claims;
  const cb = (await get(res.headers.get('location'))).headers.get('location');
  const done = await get(cb, { cookie: flow });
  const s = done.headers.getSetCookie().find((c) => c.startsWith('la_session='));
  return s ? s.split(';')[0] : null;
}

function centralEnv(idp, extra = {}) {
  return (port) => ({
    OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'listen-along', BASE_URL: `http://127.0.0.1:${port}`,
    AUTH_RATE_LIMIT: '10000', ...extra,
  });
}

// ---------------------------------------------------------------- 1. units

describe('app sign-in: rules', () => {
  it('session tokens are recognisably not CLI tokens', () => {
    assert.equal(mobileTokens.isMobileToken('lam_' + rand()), true);
    assert.equal(mobileTokens.isMobileToken(tokens.generateToken()), false, 'la_ tokens are never lam_');
    for (let i = 0; i < 200; i++) assert.ok(!tokens.generateToken().startsWith('lam_'));
    assert.equal(mobileTokens.CENTRAL_TOKEN_RE.test('lam_' + rand()), true);
    assert.equal(mobileTokens.CENTRAL_TOKEN_RE.test(rand()), false, 'a cookie id is not a Bearer');
    assert.equal(mobileTokens.mobileBearer({ authorization: 'Bearer lam_x' }), 'lam_x');
    assert.equal(mobileTokens.mobileBearer({ authorization: 'Bearer la_x' }), null);
    assert.equal(mobileTokens.mobileBearer({ authorization: 'Basic abc' }), null);
    assert.equal(mobileTokens.mobileBearer({}), null);
  });

  it('a CLI-token route sees a lam_ Bearer as no CLI token', () => {
    const req = (h) => ({ headers: { authorization: h } });
    assert.equal(tokens.hasBearer(req('Bearer la_abc')), true);
    assert.equal(tokens.hasBearer(req('Bearer lam_abc')), false);
    let status = null;
    let body = null;
    tokens.requireToken(req('Bearer lam_abc'), { status(s) { status = s; return this; }, json(b) { body = b; } }, () => assert.fail('passed'));
    assert.equal(status, 403);
    assert.equal(body.code, 'TOKEN_REQUIRED');
  });

  it('dev tokens and dev codes: signed under their own labels, never a dev cookie', () => {
    const t = mobileTokens.signDevMobileToken(SECRET, '42');
    assert.equal(mobileTokens.verifyDevMobileToken(SECRET, t).id, '42');
    assert.equal(mobileTokens.verifyDevMobileToken('other', t), null);
    assert.equal(mobileTokens.verifyDevMobileToken(SECRET, 'lam_' + cookieFor('42').split('=')[1]), null, 'a dev cookie is no app token');
    assert.equal(mobileTokens.verifyDevMobileToken(SECRET, mobileTokens.signDevMobileToken(SECRET, '42', Date.now() - 31 * 864e5)), null, 'expired');
    const code = mobileTokens.signDevCode(SECRET, { user: null, challenge: 'c', nonce: 'n' });
    assert.deepEqual({ ...mobileTokens.verifyDevCode(SECRET, code), t: 0 }, { user: null, challenge: 'c', nonce: 'n', t: 0 });
    assert.equal(mobileTokens.verifyDevCode(SECRET, code, Date.now() + 11 * 60_000), null, 'codes last 10 minutes');
    assert.equal(mobileTokens.verifyDevMobileToken(SECRET, 'lam_' + code.slice(4)), null, 'a code is no token');
  });

  it('the route policy: the round trip is public; a refused app session says SESSION_ENDED', () => {
    for (const p of ['/auth/mobile/start', '/auth/mobile/exchange', '/auth/mobile/logout']) assert.equal(policyFor(p), 'public', p);
    assert.equal(policyFor('/auth/mobile/other'), 'page', 'deny by default: no prefix rule');
    assert.equal(policyFor('/api/me'), 'self');
    assert.deepEqual(refusal(null, { mobile: true }), { status: 401, body: { error: 'Your session has ended, sign in again', code: 'SESSION_ENDED' } });
    assert.equal(refusal(null).body.code, 'AUTH_REQUIRED');
    assert.equal(refusal({ status: 'pending' }, { mobile: true }).body.code, 'ACCOUNT_PENDING');
  });

  it('the redirect URI is the one registered at the IdP', () => {
    assert.equal(MOBILE_REDIRECT_URI, 'com.etaylan.listen:/oauth2redirect');
  });
});

// ---------------------------------------------------------------- 2. dev sign-in

describe('app sign-in: dev sign-in (INSECURE_DEV_LOGIN, no database)', { timeout: 60_000 }, () => {
  let srv;
  before(async () => { srv = await startServer({ AUTH_RATE_LIMIT: '10000' }); });
  after(async () => { if (srv) await srv.stop(); });

  /** The dev page's "Continue" link, as the developer taps it. */
  async function devCode(f, extra) {
    const res = await get(startUrl(srv.base, f, extra));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /INSECURE_DEV_LOGIN/);
    const href = html.match(/id="continue" href="([^"]+)"/)[1].replace(/&amp;/g, '&');
    const u = new URL(href);
    assert.equal(`${u.protocol}${u.pathname}`, MOBILE_REDIRECT_URI);
    assert.equal(u.searchParams.get('state'), f.state);
    return u.searchParams.get('code');
  }

  it('start -> page -> exchange: a dev session that works as a Bearer', async () => {
    const f = newFlow();
    const code = await devCode(f);
    const r = await post(`${srv.base}/auth/mobile/exchange`, { code, state: f.state, code_verifier: f.verifier, nonce: f.nonce });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, 'dev');
    assert.equal(r.body.token_type, 'Bearer');
    assert.match(r.body.token, /^lam_/);
    assert.equal(r.body.user.id, 'dev');
    const me = await getJson(`${srv.base}/api/me`, bearer(r.body.token));
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user, { id: 'dev', name: '', status: 'approved' });
    assert.equal((await get(`${srv.base}/api/playlists`, bearer(r.body.token))).status, 200);
    // Signing out of a stateless dev token is forgetting it.
    assert.equal((await post(`${srv.base}/auth/mobile/logout`, undefined, bearer(r.body.token))).status, 200);
  });

  it('?user picks the account; wrong verifier, wrong nonce, reused or forged codes are refused', async () => {
    const f = newFlow();
    const code = await devCode(f, { user: '7' });
    const base = { code, state: f.state, code_verifier: f.verifier, nonce: f.nonce };
    assert.equal((await post(`${srv.base}/auth/mobile/exchange`, { ...base, code_verifier: rand(32) })).body.code, 'signin_failed');
    const f2 = newFlow();
    const code2 = await devCode(f2);
    assert.equal((await post(`${srv.base}/auth/mobile/exchange`, { code: code2, state: f2.state, code_verifier: f2.verifier, nonce: rand(16) })).body.code, 'signin_failed');
    const f3 = newFlow();
    const code3 = await devCode(f3, { user: '7' });
    const ok = await post(`${srv.base}/auth/mobile/exchange`, { code: code3, state: f3.state, code_verifier: f3.verifier, nonce: f3.nonce });
    assert.equal(ok.body.user.id, '7');
    const again = await post(`${srv.base}/auth/mobile/exchange`, { code: code3, state: f3.state, code_verifier: f3.verifier, nonce: f3.nonce });
    assert.deepEqual([again.status, again.body.code], [400, 'signin_failed'], 'a code is used once');
    const forged = mobileTokens.signDevCode('not-the-secret', { user: null, challenge: f.challenge, nonce: f.nonce });
    assert.equal((await post(`${srv.base}/auth/mobile/exchange`, { ...base, code: forged })).body.code, 'signin_failed');
  });

  it('a bad or foreign token is SESSION_ENDED, and never falls back to the cookie', async () => {
    for (const t of ['lam_garbage', 'lam_' + cookieFor('dev').split('=')[1], 'lam_' + rand()]) {
      const r = await getJson(`${srv.base}/api/playlists`, { ...bearer(t), cookie: cookieFor('dev') });
      assert.deepEqual([r.status, r.body.code], [401, 'SESSION_ENDED'], t);
    }
    assert.equal((await get(`${srv.base}/api/playlists`, { cookie: cookieFor('dev') })).status, 200, 'the cookie alone still works');
  });
});

// ---------------------------------------------------------------- 3. central, no database

describe('app sign-in: central login, protocol and sessions (no database)', { timeout: 120_000 }, () => {
  let idp;
  let srv;
  const sockets = [];
  before(async () => {
    idp = await startFakeIssuer();
    srv = await startServer(centralEnv(idp, { OIDC_RECHECK_SECONDS: '1', OIDC_MAX_UNVERIFIED_SECONDS: '30' }));
  });
  after(async () => {
    for (const s of sockets) s.disconnect();
    if (srv) await srv.stop();
    if (idp) await idp.close();
  });

  it('happy path: the IdP sees the app scheme and PKCE S256; the app gets an opaque lam_ session', async () => {
    const r = await appSignIn(srv.base, idp, { sub: 'app-1', name: 'App One', email: 'a1@example.com', email_verified: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const q = idp.authorizeRequests.at(-1);
    assert.equal(q.redirect_uri, MOBILE_REDIRECT_URI);
    assert.equal(q.code_challenge_method, 'S256');
    assert.equal(q.response_type, 'code');
    assert.match(q.scope, /offline_access/);
    assert.equal(r.body.mode, 'central');
    assert.match(r.token, mobileTokens.CENTRAL_TOKEN_RE);
    assert.ok(r.body.expires_at > Date.now() + 29 * 864e5);
    assert.deepEqual(r.body.user, { id: 'app-1', name: 'App One', status: 'approved' });
    assert.ok(!JSON.stringify(r.body).includes('eyJ'), 'no IdP token reaches the app');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const me = await getJson(`${srv.base}/api/me`, bearer(r.token));
    assert.equal(me.status, 200);
    assert.equal(me.body.session.kind, 'app');
    assert.equal((await get(`${srv.base}/api/playlists`, bearer(r.token))).status, 200);
    assert.match(srv.log(), /central-login: link rule=e user=app-1 created sub=app-1… upstream=none client=app/);
    assert.ok(!srv.log().includes(r.code), 'the code is not logged');
    assert.ok(!srv.log().includes(r.token), 'the token is not logged');
  });

  it('a wrong verifier, a wrong or missing nonce, a reused code: refused, no session', async () => {
    const wrongVerifier = await appSignIn(srv.base, idp, { sub: 'app-2' }, { over: { code_verifier: rand(32) } });
    assert.deepEqual([wrongVerifier.status, wrongVerifier.body.code], [400, 'signin_failed']);
    assert.equal(idp.lastTokenError, 'PKCE verification failed');

    const wrongNonce = await appSignIn(srv.base, idp, { sub: 'app-2' }, { over: { nonce: rand(16) } });
    assert.deepEqual([wrongNonce.status, wrongNonce.body.code], [400, 'signin_failed']);

    // An id_token minted without a nonce (a flow the app did not start) does not satisfy the app's.
    const noNonceInToken = await appSignIn(srv.base, idp, { sub: 'app-2' }, { editAuthorize: (u) => u.searchParams.delete('nonce') });
    assert.deepEqual([noNonceInToken.status, noNonceInToken.body.code], [400, 'signin_failed']);

    const b = await browse(srv.base, idp, { sub: 'app-2' });
    const missing = await post(`${srv.base}/auth/mobile/exchange`, { code: b.code, state: b.state, code_verifier: b.flow.verifier });
    assert.deepEqual([missing.status, missing.body.code], [400, 'invalid_request'], 'the nonce is required');

    const ok = await appSignIn(srv.base, idp, { sub: 'app-2' });
    assert.equal(ok.status, 200);
    const tokenCalls = idp.calls.token;
    const replay = await post(`${srv.base}/auth/mobile/exchange`, ok.sent);
    assert.deepEqual([replay.status, replay.body.code], [400, 'signin_failed']);
    assert.equal(idp.calls.token, tokenCalls, 'a replay is refused before the IdP is asked');

    for (const bad of [{}, { code: 'x', state: 'short', code_verifier: 'short', nonce: 'short' }, { ...ok.sent, code_verifier: 'a'.repeat(129) }, { ...ok.sent, iss: 5 }]) {
      assert.equal((await post(`${srv.base}/auth/mobile/exchange`, bad)).body.code, 'invalid_request');
    }
  });

  it('an id_token for another client or from another key is refused', async () => {
    idp.tamper = { aud: 'someone-else' };
    assert.equal((await appSignIn(srv.base, idp, { sub: 'app-3' })).body.code, 'signin_failed');
    idp.tamper = { key: 'other' };
    assert.equal((await appSignIn(srv.base, idp, { sub: 'app-3' })).body.code, 'signin_failed');
    idp.tamper = null;
  });

  it('start refuses bad parameters and never offers the dev page here', async () => {
    const f = newFlow();
    assert.equal((await get(startUrl(srv.base, f, { code_challenge_method: 'plain' }))).status, 400);
    assert.equal((await get(startUrl(srv.base, { ...f, challenge: 'short' }))).status, 400);
    assert.equal((await get(startUrl(srv.base, { ...f, state: '' }))).status, 400);
    const ok = await get(startUrl(srv.base, f));
    assert.equal(ok.status, 302);
    assert.ok(ok.headers.get('location').startsWith(idp.origin));
  });

  it('unknown, malformed or signed-out tokens: 401 SESSION_ENDED, everywhere the app goes', async () => {
    for (const t of ['lam_' + rand(), 'lam_short', mobileTokens.signDevMobileToken(SECRET, 'app-1')]) {
      for (const p of ['/api/me', '/api/playlists', '/api/library', '/api/library/x/file']) {
        const r = await getJson(`${srv.base}${p}`, bearer(t));
        assert.deepEqual([r.status, r.body && r.body.code], [401, 'SESSION_ENDED'], `${p} ${t.slice(0, 12)}`);
      }
    }
    const s = await appSignIn(srv.base, idp, { sub: 'app-4' });
    assert.equal((await post(`${srv.base}/auth/mobile/logout`, undefined, bearer(s.token))).status, 200);
    const after = await getJson(`${srv.base}/api/me`, bearer(s.token));
    assert.deepEqual([after.status, after.body.code], [401, 'SESSION_ENDED']);
    assert.equal(idp.calls.endSession.length, 0, 'sign-out is local: the IdP browser session is left alone');
    assert.equal((await post(`${srv.base}/auth/mobile/logout`, undefined, bearer('lam_' + rand()))).status, 200, 'idempotent');
  });

  it('signing in again replaces the session the app sent along', async () => {
    const first = await appSignIn(srv.base, idp, { sub: 'app-5' });
    const second = await appSignIn(srv.base, idp, { sub: 'app-5' }, { headers: bearer(first.token) });
    assert.equal(second.status, 200);
    assert.equal((await get(`${srv.base}/api/me`, bearer(first.token))).status, 401);
    assert.equal((await get(`${srv.base}/api/me`, bearer(second.token))).status, 200);
  });

  it('re-check: refreshed with the IdP when due; invalid_grant ends the app session', async () => {
    const s = await appSignIn(srv.base, idp, { sub: 'app-6' });
    await sleep(1100);
    const refreshes = idp.calls.refresh;
    assert.equal((await get(`${srv.base}/api/me`, bearer(s.token))).status, 200);
    assert.equal(idp.calls.refresh, refreshes + 1, 'the app session was re-checked');
    idp.disable('app-6');
    await sleep(1100);
    const r = await getJson(`${srv.base}/api/playlists`, bearer(s.token));
    assert.deepEqual([r.status, r.body.code], [401, 'SESSION_ENDED']);
    idp.enable('app-6');
    assert.equal((await get(`${srv.base}/api/me`, bearer(s.token))).status, 401, 'stays ended');
  });

  it('IdP down: no session ends, sign-in says unavailable (503), never "signed out"', async () => {
    const s = await appSignIn(srv.base, idp, { sub: 'app-7' });
    await sleep(1100);
    idp.down = 'http503';
    assert.equal((await get(`${srv.base}/api/me`, bearer(s.token))).status, 200, 'kept while the IdP is silent');
    const b = await browse(srv.base, idp, { sub: 'app-7' });
    const r = await post(`${srv.base}/auth/mobile/exchange`, { code: b.code, state: b.state, code_verifier: b.flow.verifier, nonce: b.flow.nonce });
    assert.deepEqual([r.status, r.body.code], [503, 'signin_unavailable']);
    idp.down = false;
  });

  it('web cookies and the app session are separate: neither works as the other', async () => {
    const cookie = await webSignIn(srv.base, idp, { sub: 'web-1' });
    assert.ok(cookie);
    assert.equal((await get(`${srv.base}/api/playlists`, { cookie })).status, 200, 'the web session is unaffected');
    assert.notEqual((await get(`${srv.base}/api/me`, { cookie })).status, 200, '/api/me stays CLI-token / app only');
    const raw = cookie.split('=')[1];
    assert.equal((await get(`${srv.base}/api/playlists`, bearer('lam_' + raw.slice(0, 43)))).status, 401, 'a cookie id is no Bearer');
    const app = await appSignIn(srv.base, idp, { sub: 'web-1' });
    assert.equal((await get(`${srv.base}/api/playlists`, { cookie: `la_session=${app.token}` })).status, 401, 'an app token is no cookie');
    assert.equal((await get(`${srv.base}/api/playlists`, { cookie: `la_session=${app.token.slice(4)}` })).status, 401);
    const both = await getJson(`${srv.base}/api/playlists`, { cookie, ...bearer('lam_' + rand()) });
    assert.deepEqual([both.status, both.body.code], [401, 'SESSION_ENDED'], 'a bad Bearer never falls back to the cookie');
  });

  it('CLI-only routes and admin refuse an app session without signing it out', async () => {
    const s = await appSignIn(srv.base, idp, { sub: 'app-8' });
    for (const [method, p] of [['POST', '/api/library/upload'], ['POST', '/api/library/check'], ['GET', '/api/cli/latest']]) {
      const r = await fetch(`${srv.base}${p}`, { method, headers: bearer(s.token) });
      assert.equal(r.status, 403, p);
      assert.equal((await r.json()).code, 'TOKEN_REQUIRED', p);
    }
    assert.equal((await get(`${srv.base}/api/admin/tokens`, bearer(s.token))).status, 401, 'admin is the la_admin cookie only');
    assert.equal((await get(`${srv.base}/api/me`, bearer(s.token))).status, 200, 'still signed in');
  });

  it('sockets stay cookie-only: an app token opens none', async () => {
    const s = await appSignIn(srv.base, idp, { sub: 'app-9' });
    const sock = ioClient(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: bearer(s.token) });
    sockets.push(sock);
    const outcome = await new Promise((resolve) => { sock.on('connect', () => resolve('connected')); sock.on('connect_error', (e) => resolve(e.message)); });
    assert.equal(outcome, 'Authentication required');
    // Control: the same client with a web session cookie connects (so the refusal is the token's).
    const cookie = await webSignIn(srv.base, idp, { sub: 'app-9' });
    const ok = ioClient(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie } });
    sockets.push(ok);
    assert.equal(await new Promise((resolve) => { ok.on('connect', () => resolve('connected')); ok.on('connect_error', (e) => resolve(e.message)); }), 'connected');
  });
});

describe('app sign-in: limits and outages', { timeout: 60_000 }, () => {
  it('rate limited per client address', async () => {
    const idp = await startFakeIssuer();
    const srv = await startServer(centralEnv(idp, { AUTH_RATE_LIMIT: '3' }));
    try {
      const f = newFlow();
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await get(startUrl(srv.base, f))).status);
      assert.deepEqual(codes, [302, 302, 302, 429]);
      assert.equal((await post(`${srv.base}/auth/mobile/exchange`, {})).status, 429);
    } finally {
      await srv.stop();
      await idp.close();
    }
  });

  it('DATABASE_URL set but the database down: sign-in fails closed (503) before the code is spent; tokens 503', async () => {
    const idp = await startFakeIssuer();
    const deadPort = await freePort();
    const srv = await startServer(centralEnv(idp, { DATABASE_URL: `postgres://x:y@127.0.0.1:${deadPort}/none` }));
    try {
      const b = await browse(srv.base, idp, { sub: 'down-1' });
      const calls = idp.calls.token;
      const r = await post(`${srv.base}/auth/mobile/exchange`, { code: b.code, state: b.state, code_verifier: b.flow.verifier, nonce: b.flow.nonce });
      assert.deepEqual([r.status, r.body.code], [503, 'signin_unavailable']);
      assert.equal(idp.calls.token, calls, 'the IdP was not asked');
      assert.equal((await get(`${srv.base}/api/playlists`, bearer('lam_' + rand()))).status, 503, 'never a 401: the app must not sign out');
      assert.equal((await post(`${srv.base}/auth/mobile/logout`, undefined, bearer('lam_' + rand()))).status, 503);
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

describe('app sign-in on Postgres: linking, bans, the app\'s API', { skip: pgSkip, timeout: 240_000 }, () => {
  let container;
  let pg;
  let idp;
  let srv;
  let tmp;
  const U = {};

  const addUser = async (key, { provider = 'google', providerId = key, status = 'approved', createdAt = Date.now() } = {}) => {
    const r = await pg.query(
      'INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [provider, providerId, `Legacy ${key}`, status, createdAt]
    );
    U[key] = r.rows[0].id;
    await pg.query('INSERT INTO user_providers (user_id, provider, provider_id, name, linked_at) VALUES ($1, $2, $3, $4, $5)',
      [U[key], provider, providerId, `Legacy ${key}`, createdAt]);
    return U[key];
  };
  const userCount = async () => (await pg.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  const putSetting = (v) => fetch(`${srv.base}/api/admin/settings`, { method: 'PUT', headers: { cookie: adminCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ registrations_open: v }) });

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('listen_mobile').withUsername('test').withPassword('test').start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-mobile-test-'));
    idp = await startFakeIssuer();
    srv = await startServer(centralEnv(idp, {
      DATABASE_URL: container.getConnectionUri(), SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'),
      APP_RELEASES_API_URL: 'http://127.0.0.1:9/', REGISTRATIONS_DEFAULT: 'closed',
      OIDC_SCOPES: 'openid email profile entitlements offline_access upstream',
    }));
    const { Client } = require('pg');
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    await addUser('legacy1', { providerId: 'g-1', createdAt: 1000 });
    await addUser('denied2', { providerId: 'g-2', status: 'denied', createdAt: 2000 });
    await addUser('pending3', { providerId: 'g-3', status: 'pending', createdAt: 3000 });
    await addUser('ban4', { providerId: 'g-4', createdAt: 4000 });
  });
  after(async () => {
    if (srv) await srv.stop();
    if (idp) await idp.close();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('registrations closed: an unmatched identity is refused, nothing created', async () => {
    const before = await userCount();
    const r = await appSignIn(srv.base, idp, { sub: 'm-nomatch', email: 'n@example.com', email_verified: true });
    assert.deepEqual([r.status, r.body.code], [403, 'registrations_closed']);
    assert.equal(r.token, undefined);
    assert.equal(await userCount(), before);
    assert.match(srv.log(), /central-login: refused rule=e reason=registrations_closed user=- sub=m-nomatc… upstream=MISSING\(#1\) client=app/);
  });

  it('rule b: an upstream id links the legacy account; the session is that account', async () => {
    const r = await appSignIn(srv.base, idp, { sub: 'm-1', name: 'Central One', upstream_identities: [{ provider: 'google', id: 'g-1' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.id, U.legacy1);
    assert.equal(r.body.user.name, 'Central One');
    assert.equal((await pg.query('SELECT oidc_sub FROM users WHERE id = $1', [U.legacy1])).rows[0].oidc_sub, 'm-1');
    assert.equal((await getJson(`${srv.base}/api/me`, bearer(r.token))).body.user.id, U.legacy1);
    assert.match(srv.log(), new RegExp(`central-login: link rule=b user=${U.legacy1} linked sub=m-1… upstream=1 client=app`));
    // Rule a next time; the web lands on the same account.
    const again = await appSignIn(srv.base, idp, { sub: 'm-1' });
    assert.equal(again.body.user.id, U.legacy1);
    const cookie = await webSignIn(srv.base, idp, { sub: 'm-1' });
    assert.equal((await (await get(`${srv.base}/api/auth/me`, { cookie })).json()).user.id, U.legacy1);
  });

  it('link_conflict: another identity claiming a linked upstream account is refused (409)', async () => {
    const before = await userCount();
    const r = await appSignIn(srv.base, idp, { sub: 'm-1-impostor', upstream_identities: [{ provider: 'google', id: 'g-1' }] });
    assert.deepEqual([r.status, r.body.code], [409, 'link_conflict']);
    assert.equal(await userCount(), before);
  });

  it('a denied account is refused (403 account_disabled), no session', async () => {
    const r = await appSignIn(srv.base, idp, { sub: 'm-2', upstream_identities: [{ provider: 'google', id: 'g-2' }] });
    assert.deepEqual([r.status, r.body.code], [403, 'account_disabled']);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1', [U.denied2])).rows[0].n, 0);
  });

  it('a pending account signs in but reaches only what a pending web user does', async () => {
    const r = await appSignIn(srv.base, idp, { sub: 'm-3', upstream_identities: [{ provider: 'google', id: 'g-3' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.status, 'pending');
    assert.equal((await getJson(`${srv.base}/api/me`, bearer(r.token))).body.user.status, 'pending');
    const lib = await getJson(`${srv.base}/api/library`, bearer(r.token));
    assert.deepEqual([lib.status, lib.body.code], [403, 'ACCOUNT_PENDING']);
    assert.equal((await get(`${srv.base}/api/app/latest`, bearer(r.token))).status, 200, 'member routes are open, as on the web');
  });

  it('registrations open: a new account is made', async () => {
    assert.equal((await putSetting(true)).status, 200);
    const r = await appSignIn(srv.base, idp, { sub: 'm-new', name: 'Newcomer', email: 'new@example.com', email_verified: true });
    assert.equal(r.status, 200);
    const row = (await pg.query('SELECT provider, status, name FROM users WHERE oidc_sub = $1', ['m-new'])).rows[0];
    assert.deepEqual(row, { provider: 'oidc', status: 'approved', name: 'Newcomer' });
  });

  it('the app\'s API surface works with the session; CLI tokens are unaffected', async () => {
    const s = await appSignIn(srv.base, idp, { sub: 'm-1' });
    const h = bearer(s.token);
    assert.equal((await get(`${srv.base}/api/library?limit=1`, h)).status, 200);
    assert.equal((await get(`${srv.base}/api/library?reported=1`, h)).status, 200);
    const missing = crypto.randomUUID();
    assert.equal((await get(`${srv.base}/api/library/${missing}/file`, h)).status, 404, 'a missing song is a 404, never a 401');
    assert.equal((await post(`${srv.base}/api/library/${missing}/report`, { reason: 'x' }, h)).status, 404);
    const created = await post(`${srv.base}/api/playlists`, { name: 'From the phone', visibility: 'private' }, h);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.ownerId, U.legacy1, 'acts as the signed-in user');
    const list = await getJson(`${srv.base}/api/playlists`, h);
    assert.ok(list.body.playlists.some((p) => p.id === created.body.id && p.isOwner));
    const rename = await fetch(`${srv.base}/api/playlists/${created.body.id}`, { method: 'PATCH', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) });
    assert.equal(rename.status, 200);

    const cli = 'la_' + rand();
    await pg.query('INSERT INTO api_tokens (name, token_hash, token_prefix, user_id) VALUES ($1, $2, $3, $4)', ['Laptop', sha256hex(cli), cli.slice(0, 10), U.legacy1]);
    const me = await getJson(`${srv.base}/api/me`, bearer(cli));
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.token, { label: 'Laptop', legacy: false }, 'the CLI /api/me is unchanged');
    assert.equal((await get(`${srv.base}/api/playlists/${created.body.id}/songs`, bearer(cli))).status, 200);
    assert.equal((await get(`${srv.base}/api/cli/latest`, bearer(cli))).status !== 403, true);
    assert.equal((await get(`${srv.base}/api/me`, bearer('la_' + rand()))).status, 401, 'a bad CLI token is still a plain 401');
  });

  it('ban: the app session ends at once (401 SESSION_ENDED) and signing in is refused', async () => {
    const s = await appSignIn(srv.base, idp, { sub: 'm-4', upstream_identities: [{ provider: 'google', id: 'g-4' }] });
    assert.equal((await get(`${srv.base}/api/playlists`, bearer(s.token))).status, 200);
    assert.equal((await fetch(`${srv.base}/api/dashboard/users/${U.ban4}/reject`, { method: 'PUT', headers: { cookie: adminCookie() } })).status, 200);
    const r = await getJson(`${srv.base}/api/playlists`, bearer(s.token));
    assert.deepEqual([r.status, r.body.code], [401, 'SESSION_ENDED']);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1', [U.ban4])).rows[0].n, 0);
    assert.equal((await appSignIn(srv.base, idp, { sub: 'm-4' })).body.code, 'account_disabled');
    await fetch(`${srv.base}/api/dashboard/users/${U.ban4}/approve`, { method: 'PUT', headers: { cookie: adminCookie() } });
    assert.equal((await appSignIn(srv.base, idp, { sub: 'm-4' })).status, 200, 'unban: signing in works again');
  });

  it('an expired session is SESSION_ENDED; at rest only the hash and encrypted tokens are stored', async () => {
    const s = await appSignIn(srv.base, idp, { sub: 'm-1' });
    const row = (await pg.query('SELECT * FROM user_sessions WHERE id_hash = $1', [sha256hex(s.token)])).rows[0];
    assert.ok(row, 'stored as the SHA-256 of the whole token');
    assert.equal(String(row.user_id), String(U.legacy1));
    const stored = JSON.stringify(row);
    assert.ok(!stored.includes(s.token) && !stored.includes(s.token.slice(4)), 'the token itself is not stored');
    assert.match(row.refresh_token_enc, /^v1\./, 'the refresh token is sealed');
    assert.ok(![...idp.refreshTokens.keys()].some((t) => stored.includes(t)), 'no refresh token in the clear');
    await pg.query('UPDATE user_sessions SET expires_at = $2 WHERE id_hash = $1', [row.id_hash, Date.now() - 1000]);
    const r = await getJson(`${srv.base}/api/me`, bearer(s.token));
    assert.deepEqual([r.status, r.body.code], [401, 'SESSION_ENDED']);
  });
});

// ---------------------------------------------------------------- 5. hardening (no database)

describe('app sign-in: hardening', { timeout: 120_000 }, () => {
  let idp;
  let srv;
  before(async () => {
    idp = await startFakeIssuer();
    srv = await startServer(centralEnv(idp));
  });
  after(async () => {
    if (srv) await srv.stop();
    if (idp) await idp.close();
  });
  const exchange = (body, headers) => post(`${srv.base}/auth/mobile/exchange`, body, headers);
  const bodyOf = (b) => ({ code: b.code, state: b.state, code_verifier: b.flow.verifier, nonce: b.flow.nonce });

  it('a retry after an IdP outage (503) can use the same code; definite outcomes stay burned', async () => {
    const b = await browse(srv.base, idp, { sub: 'h-1' });
    idp.down = 'http503';
    const first = await exchange(bodyOf(b));
    assert.deepEqual([first.status, first.body.code], [503, 'signin_unavailable']);
    idp.down = false;
    const retry = await exchange(bodyOf(b));
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal((await exchange(bodyOf(b))).body.code, 'signin_failed', 'used: burned');
    const wrong = await browse(srv.base, idp, { sub: 'h-1' });
    assert.equal((await exchange({ ...bodyOf(wrong), code_verifier: rand(32) })).body.code, 'signin_failed');
    assert.equal((await exchange(bodyOf(wrong))).body.code, 'signin_failed', 'a refused code stays burned');
  });

  it('bodies of the wrong shape or size are refused cleanly (400 / 413, never 500)', async () => {
    const b = await browse(srv.base, idp, { sub: 'h-2' });
    const good = bodyOf(b);
    for (const bad of [
      { ...good, code: [good.code] }, { ...good, state: { $ne: '' } }, { ...good, nonce: 12345678901234567 },
      { ...good, code_verifier: null }, { ...good, iss: ['http://x'] },
    ]) {
      const r = await exchange(bad);
      assert.deepEqual([r.status, r.body && r.body.code], [400, 'invalid_request'], JSON.stringify(bad).slice(0, 60));
    }
    assert.equal((await exchange([good])).status, 400, 'an array body');
    const raw = (text) => fetch(`${srv.base}/auth/mobile/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
    assert.equal((await raw('{"code":')).status, 400, 'malformed JSON');
    assert.equal((await raw(JSON.stringify({ ...good, pad: 'x'.repeat(200 * 1024) }))).status, 413, 'oversized');
    assert.equal((await exchange(good)).status, 200, 'none of that burned the code');
  });

  it('the start request\'s state, nonce and challenge stay out of the access log', async () => {
    const f = newFlow();
    assert.equal((await get(startUrl(srv.base, f))).status, 302);
    assert.equal((await get(startUrl(srv.base, f).replace('/auth/mobile/start', '/AUTH/mobile/start'))).status, 302);
    await sleep(100);
    const log = srv.log();
    assert.ok(!log.includes(f.state) && !log.includes(f.nonce) && !log.includes(f.challenge));
    assert.match(log, /\[http\] GET \/auth\/mobile\/start\?… 302/);
  });

  it('a web code is no app code, and an app code no web code', async () => {
    // The web flow's code (redirect_uri = the web callback) at the app's exchange.
    const login = await get(`${srv.base}/auth/oidc/login`);
    const flowCookie = login.headers.getSetCookie().find((c) => c.startsWith('la_oidc_flow=')).split(';')[0];
    const webState = new URL(login.headers.get('location')).searchParams.get('state');
    idp.user = { sub: 'h-3' };
    const webCb = new URL((await get(login.headers.get('location'))).headers.get('location'));
    const r = await exchange({ code: webCb.searchParams.get('code'), state: webCb.searchParams.get('state'), code_verifier: rand(32), nonce: rand(16) });
    assert.deepEqual([r.status, r.body.code], [400, 'signin_failed']);
    // The app's code at the web callback, with a live web flow and its own state.
    const app = await browse(srv.base, idp, { sub: 'h-3' });
    const done = await get(`${srv.base}/auth/oidc/callback?code=${encodeURIComponent(app.code)}&state=${encodeURIComponent(webState)}`, { cookie: flowCookie });
    assert.equal(done.headers.get('location'), '/login?error=signin_failed');
    assert.ok(!done.headers.getSetCookie().some((c) => /^la_session=[^;]/.test(c)), 'no session');
  });

  it('start ignores redirect_uri, scope, prompt, client_id and response_type from the request', async () => {
    const f = newFlow();
    const r = await get(startUrl(srv.base, f, {
      redirect_uri: 'https://evil.example/cb', scope: 'openid admin', prompt: 'none', client_id: 'other', response_type: 'token',
    }));
    const q = new URL(r.headers.get('location')).searchParams;
    assert.equal(q.get('redirect_uri'), MOBILE_REDIRECT_URI);
    assert.equal(q.get('scope'), 'openid email profile entitlements offline_access');
    assert.equal(q.get('client_id'), 'listen-along');
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('prompt'), null);
    assert.equal(q.getAll('redirect_uri').length, 1);
  });

  it('an iss from another issuer, an expired id_token and alg none are refused', async () => {
    assert.equal((await appSignIn(srv.base, idp, { sub: 'h-4' }, { over: { iss: 'https://evil.example/' } })).body.code, 'signin_failed');
    idp.tamper = { exp: Math.floor(Date.now() / 1000) - 3600 };
    assert.equal((await appSignIn(srv.base, idp, { sub: 'h-4' })).body.code, 'signin_failed');
    idp.tamper = { alg: 'none' };
    assert.equal((await appSignIn(srv.base, idp, { sub: 'h-4' })).body.code, 'signin_failed');
    idp.tamper = null;
    assert.equal((await appSignIn(srv.base, idp, { sub: 'h-4' }, { over: { iss: idp.issuer } })).status, 200, 'the right iss is fine');
  });

  it('an app session adds nothing to admin: only a valid la_admin cookie is admin', async () => {
    const s = await appSignIn(srv.base, idp, { sub: 'h-5' });
    const url = `${srv.base}/api/admin/settings`;
    assert.equal((await get(url, bearer(s.token))).status, 401);
    assert.equal((await get(url, { ...bearer(s.token), cookie: 'la_admin=forged' })).status, 401);
    const web = await webSignIn(srv.base, idp, { sub: 'h-5' });
    assert.equal((await get(url, { ...bearer(s.token), cookie: web })).status, 401);
    // The admin cookie is a credential of its own; the Bearer neither grants nor blocks it.
    assert.equal((await get(url, { cookie: adminCookie() })).status, 200);
    assert.equal((await get(url, { ...bearer(s.token), cookie: adminCookie() })).status, 200);
  });

  it('a session token in the query string is no credential; sign-out with no or an unknown token is harmless', async () => {
    const s = await appSignIn(srv.base, idp, { sub: 'h-6' });
    for (const name of ['access_token', 'token', 'session']) {
      const r = await getJson(`${srv.base}/api/playlists?${name}=${s.token}`);
      assert.deepEqual([r.status, r.body.code], [401, 'AUTH_REQUIRED'], name);
    }
    assert.deepEqual((await post(`${srv.base}/auth/mobile/logout`)).body, { success: true });
    assert.deepEqual((await post(`${srv.base}/auth/mobile/logout`, undefined, bearer('lam_' + rand()))).body, { success: true });
    assert.equal((await get(`${srv.base}/api/me`, bearer(s.token))).status, 200, 'neither ended the real session');
  });
});
