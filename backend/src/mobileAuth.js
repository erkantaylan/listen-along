/**
 * The Android app's sign-in through the central login (CENTRAL-LOGIN.md,
 * "The Android app"). A backend-held session: the app runs the authorization
 * code flow with PKCE in a Custom Tab, the SERVER exchanges the code and
 * validates the id_token exactly as the web callback does, links the account
 * with the same rules (oidcLink.js), and opens a session in the same store
 * (oidcSessions.js: refresh token encrypted at rest, re-checked with the IdP).
 * The app only ever holds an opaque `lam_` session token (mobileTokens.js),
 * sent as `Authorization: Bearer`; it never sees an IdP token. Mounted by
 * authRoutes.js on its router (after the guard; the routes are public in
 * userAuth.policyFor and check what they need themselves).
 *
 *   GET  /auth/mobile/start?state&nonce&code_challenge&code_challenge_method=S256
 *        The app opens this in a Custom Tab. It made state, nonce and the PKCE
 *        verifier itself and keeps them. Central login: 302 to the IdP's
 *        authorize endpoint with redirect_uri = the app's registered scheme
 *        (MOBILE_REDIRECT_URI), the server's scopes. The IdP sends the browser
 *        back to the app with ?code&state (or ?error). Dev sign-in: a page whose
 *        link goes straight back to the app with a signed dev code.
 *   POST /auth/mobile/exchange  { code, state, code_verifier, nonce, iss? }
 *        200 { token: 'lam_...', token_type: 'Bearer', expires_at, mode:
 *        'central'|'dev', user: { id, name, status } }. Errors are
 *        { error, code } with code invalid_request (400), signin_failed (400:
 *        a code that is wrong, used, expired, or does not fit the verifier;
 *        an id_token that fails any check, the nonce included),
 *        account_disabled / registrations_closed (403), link_conflict (409),
 *        signin_unavailable (503: the IdP or the database cannot be reached).
 *        429 from the rate limit. A `lam_` Bearer sent along (the app's
 *        previous session) is ended once the new one exists.
 *   POST /auth/mobile/logout   (Bearer lam_...) ends that session: 200 { success }.
 *        Local only: the IdP's browser session (Chrome on the phone) is left
 *        alone, so signing in again is a tap. The refresh token goes with the
 *        session row.
 *   GET  /api/me              (Bearer lam_...) { name, user: { id, name, status },
 *        session: { kind: 'app' } }; pending accounts too. A CLI token's
 *        /api/me stays in libraryRoutes.js.
 *
 * What stops what:
 *   - someone else's code (intercepted redirect, another app claiming the
 *     scheme): useless without the verifier, which never leaves the app until
 *     the exchange; the IdP checks it (PKCE S256);
 *   - a forged redirect into the app (login CSRF): the app compares `state`;
 *   - a replayed id_token / mixed-up flow: the server passes the app's nonce
 *     as the expected nonce, so an id_token minted for another flow fails;
 *   - a replayed exchange: codes are single-use at the IdP, and the server
 *     refuses a code it has already seen (10 min, in memory: one instance)
 *     before asking the IdP; only an undecided attempt (503
 *     signin_unavailable) gives the code back for a retry;
 *   - bans, re-checks, expiry: the same session store as the web, so the same
 *     machinery; userAuth.js turns the Bearer into the user.
 */

const crypto = require('crypto');
const express = require('express');
const { make: makeLimiter } = require('./rateLimits');
const { linkCentralIdentity, centralName } = require('./oidcLink');
const { hashId, SESSION_MAX_AGE_MS } = require('./oidcSessions');
const {
  MOBILE_TOKEN_PREFIX, CENTRAL_TOKEN_RE, mobileBearer, signDevMobileToken, signDevCode, verifyDevCode, s256,
} = require('./mobileTokens');

/** Registered with the IdP for the listen-along client (central-login catalog). */
const MOBILE_REDIRECT_URI = 'com.etaylan.listen:/oauth2redirect';

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;      // base64url(SHA-256)
const STATE_RE = /^[A-Za-z0-9._~-]{16,256}$/;    // state and nonce
const CODE_RE = /^[\x21-\x7e]{1,2048}$/;
const USED_CODE_TTL_MS = 10 * 60 * 1000;
const USED_CODE_MAX = 10_000;

const MESSAGES = {
  invalid_request: 'The sign-in request is not valid',
  signin_failed: 'Sign-in did not work, try again',
  signin_unavailable: 'Sign-in cannot be reached right now, try again later',
  account_disabled: 'Your account has been disabled',
  registrations_closed: 'Registrations are closed',
  link_conflict: 'This sign-in could not be linked to your account, contact the administrator',
};
const STATUS = {
  invalid_request: 400, signin_failed: 400, signin_unavailable: 503,
  account_disabled: 403, registrations_closed: 403, link_conflict: 409,
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A bare page for the Custom Tab (errors, the dev sign-in). */
function page(res, status, title, bodyHtml) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 16px;` +
    `background:#16181d;color:#e6e8ee}a.button,button{display:inline-block;padding:.6rem 1rem;border-radius:8px;border:0;` +
    `background:#7aa2f7;color:#16181d;text-decoration:none;font:inherit}input{font:inherit;padding:.5rem;border-radius:8px;` +
    `border:1px solid #444;background:#1f2229;color:inherit}p.muted{color:#9aa0ab;font-size:14px}</style></head>` +
    `<body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`
  );
}

const appRedirect = (params) => `${MOBILE_REDIRECT_URI}?${new URLSearchParams(params)}`;

/**
 * @param oidc        createOidcClient() (central login) or null (dev sign-in)
 * @param cfg         readOidcConfig() result
 * @param store       createSessionStore() (central login) or null
 * @param settings    createSettings() (registrations switch)
 * @param userAuth    createUserAuth() (invalidate, getAccount, requireLevel)
 * @param db          db module
 * @param dbExpected  DATABASE_URL is set: no pool = an outage, fail closed
 * @param devLogin    INSECURE_DEV_LOGIN is on (development / tests only)
 * @param secret      SESSION_SECRET (signs dev codes and dev tokens)
 */
function createMobileAuthRouter({
  oidc = null, cfg = { enabled: false }, store = null, settings, userAuth, db, dbExpected = false,
  devLogin = false, secret, env = process.env, logger = console, now = () => Date.now(),
}) {
  if (!oidc === !devLogin) throw new Error('createMobileAuthRouter: exactly one of oidc (central login) or devLogin');
  const router = express.Router();

  // Sign-in round trips per client address, like the web's (AUTH_RATE_LIMIT,
  // default 30 a minute; a budget of its own).
  const authLimit = Number.parseInt(env.AUTH_RATE_LIMIT, 10);
  const limiter = makeLimiter(Number.isFinite(authLimit) && authLimit > 0 ? authLimit : 30, 60 * 1000, { message: 'Too many sign-in attempts, try again in a minute' });

  // Codes already submitted (SHA-256 -> when it may be forgotten). A code
  // stays burned after every definite outcome; only "could not be decided"
  // (the IdP or the database unreachable: 503 signin_unavailable) releases
  // it, so the app's retry with the same code can still work.
  const usedCodes = new Map();
  const codeKey = (code) => crypto.createHash('sha256').update(code).digest('hex');
  function firstUse(code) {
    const t = now();
    for (const [k, until] of usedCodes) { if (until > t) break; usedCodes.delete(k); }
    const key = codeKey(code);
    if (usedCodes.has(key)) return false;
    if (usedCodes.size >= USED_CODE_MAX) usedCodes.delete(usedCodes.keys().next().value);
    usedCodes.set(key, t + USED_CODE_TTL_MS);
    return true;
  }
  const release = (code) => usedCodes.delete(codeKey(code));

  const fail = (res, code, error = MESSAGES[code]) => res.status(STATUS[code]).json({ error, code });
  const short = (x) => `${String(x).slice(0, 8)}…`;
  let missingUpstream = 0;

  // ---- start ---------------------------------------------------------------

  router.get('/auth/mobile/start', limiter, async (req, res) => {
    const q = req.query;
    const state = typeof q.state === 'string' ? q.state : '';
    const nonce = typeof q.nonce === 'string' ? q.nonce : '';
    const challenge = typeof q.code_challenge === 'string' ? q.code_challenge : '';
    if (!STATE_RE.test(state) || !STATE_RE.test(nonce) || !CHALLENGE_RE.test(challenge) || (q.code_challenge_method || 'S256') !== 'S256') {
      return page(res, 400, 'Sign-in link not valid', '<p>Go back to the app and tap Sign in again.</p>');
    }

    if (devLogin) {
      const asked = typeof q.user === 'string' ? q.user.trim().slice(0, 100) : '';
      const code = signDevCode(secret, { user: asked || null, challenge, nonce }, now());
      const hidden = { state, nonce, code_challenge: challenge, code_challenge_method: 'S256' };
      return page(res, 200, 'Development sign-in',
        '<p class="muted">This server runs with INSECURE_DEV_LOGIN: anyone can sign in as anyone. Development only.</p>' +
        `<p><a class="button" id="continue" href="${escapeHtml(appRedirect({ code, state }))}">Continue as ${escapeHtml(asked ? `user ${asked}` : 'Dev User')}</a></p>` +
        '<form method="get" action="/auth/mobile/start"><p class="muted">Or as another account (users.id):</p>' +
        Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('') +
        '<input name="user" placeholder="users.id" autocomplete="off"> <button type="submit">Use it</button></form>');
    }

    try {
      const url = await oidc.authorizationUrl({ redirectUri: MOBILE_REDIRECT_URI, state, nonce, codeChallenge: challenge });
      res.set('Cache-Control', 'no-store');
      return res.redirect(url);
    } catch (err) {
      logger.error(`[oidc] could not start an app sign-in: ${err.message}`);
      return page(res, 503, 'Sign-in unavailable',
        '<p>Sign-in cannot be reached right now. Try again in a little while.</p>' +
        `<p><a class="button" href="${escapeHtml(appRedirect({ error: 'temporarily_unavailable', state }))}">Back to the app</a></p>`);
    }
  });

  // ---- exchange ------------------------------------------------------------

  /** Central login: the code -> claims + tokens, validated as at the web callback. */
  async function exchangeCentral(b) {
    const query = new URLSearchParams({ code: b.code, state: b.state });
    if (b.iss) query.set('iss', b.iss);
    return oidc.finishLogin(query.toString(), { state: b.state, nonce: b.nonce, verifier: b.code_verifier }, { redirectUri: MOBILE_REDIRECT_URI });
  }

  /** The account a central sign-in lands on; same rules and log line as the web callback. */
  async function linkCentral(claims) {
    let upstreamNote = Array.isArray(claims.upstream_identities) ? String(claims.upstream_identities.length) : 'none';
    if (cfg.upstreamExpected && !Object.prototype.hasOwnProperty.call(claims, 'upstream_identities')) {
      missingUpstream++;
      upstreamNote = `MISSING(#${missingUpstream})`;
    }
    let linked;
    if (db.isAvailable()) {
      linked = await linkCentralIdentity({ db, claims, providerMap: cfg.providerMap, registrationsOpen: () => settings.registrationsOpen() });
    } else if (await settings.registrationsOpen()) {
      // No database at all (development): the sub is the user id, approved.
      linked = { outcome: 'ok', rule: 'e', created: true, user: { id: claims.sub, status: 'approved', name: centralName(claims) } };
    } else {
      linked = { outcome: 'refused', rule: 'e', reason: 'registrations_closed' };
    }
    if (linked.outcome !== 'ok') {
      logger.log(`central-login: refused rule=${linked.rule || '-'} reason=${linked.reason} user=${linked.user ? linked.user.id : '-'} sub=${short(claims.sub)} upstream=${upstreamNote} client=app`);
    } else {
      const how = linked.created ? 'created' : linked.rule === 'a' ? 'signed-in' : 'linked';
      logger.log(`central-login: link rule=${linked.rule} user=${linked.user.id} ${how} sub=${short(claims.sub)} upstream=${upstreamNote} client=app`);
    }
    return linked;
  }

  /** Dev sign-in: the account a dev code names (or the Dev User), as /auth/dev/login picks it. */
  async function devUser(asked) {
    if (!db.isAvailable()) return { id: asked || 'dev', status: 'approved' };
    if (asked) {
      const r = await db.query('SELECT id, status FROM users WHERE id::text = $1', [asked]);
      return r.rows[0] || null;
    }
    const find = () => db.query(`SELECT id, status FROM users WHERE provider = 'dev' AND provider_id = 'dev'`);
    let r = await find();
    if (!r.rows[0]) {
      await db.query(
        `INSERT INTO users (provider, provider_id, name, status, created_at, updated_at)
         VALUES ('dev', 'dev', 'Dev User', 'approved', $1, $1) ON CONFLICT DO NOTHING`,
        [Date.now()]
      );
      r = await find();
    }
    return r.rows[0];
  }

  router.post('/auth/mobile/exchange', limiter, async (req, res) => {
    // The body is parsed by the app-wide express.json() (httpApp.js, 100 kB:
    // a bigger body is a 413, malformed JSON a 400, before this runs).
    res.set('Cache-Control', 'no-store');
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const ok = typeof b.code === 'string' && CODE_RE.test(b.code)
      && typeof b.state === 'string' && STATE_RE.test(b.state)
      && typeof b.nonce === 'string' && STATE_RE.test(b.nonce)
      && typeof b.code_verifier === 'string' && VERIFIER_RE.test(b.code_verifier)
      && (b.iss === undefined || b.iss === null || (typeof b.iss === 'string' && b.iss.length <= 512));
    if (!ok) return fail(res, 'invalid_request');
    if (!b.iss) delete b.iss;

    // Database configured but not there: no session can be stored, and no
    // account invented in memory. Before the code is spent.
    if (dbExpected && !db.isAvailable()) {
      logger.error('central-login: REFUSED app sign-in: DATABASE_URL is set but the database is unavailable');
      return fail(res, 'signin_unavailable');
    }
    if (!firstUse(b.code)) {
      logger.warn('[oidc] app sign-in refused: that code was already submitted');
      return fail(res, 'signin_failed');
    }
    // Not decided (IdP or database unreachable): the code may be tried again.
    const unavailable = () => {
      release(b.code);
      return fail(res, 'signin_unavailable');
    };

    let userId;
    let account;
    let token;
    let mode;
    let knownName = null; // the IdP's name, for a no-database account
    if (devLogin) {
      const c = verifyDevCode(secret, b.code, now());
      if (!c || c.nonce !== b.nonce || s256(b.code_verifier) !== c.challenge) return fail(res, 'signin_failed');
      let u;
      try { u = await devUser(c.user); } catch (err) {
        logger.error('[auth] dev app sign-in failed:', err.message);
        return unavailable();
      }
      if (!u) return fail(res, 'signin_failed', 'No user with that id');
      if (u.status === 'denied' || u.status === 'rejected') return fail(res, 'account_disabled');
      userId = String(u.id);
      token = signDevMobileToken(secret, userId, now());
      mode = 'dev';
      logger.log(`[auth] dev sign-in (app) user=${userId}`);
    } else {
      let result;
      try {
        result = await exchangeCentral(b);
      } catch (err) {
        logger.warn(`[oidc] app sign-in rejected (${err.kind || 'error'}): ${err.message}`);
        return err.kind === 'unavailable' ? unavailable() : fail(res, 'signin_failed');
      }
      const { claims } = result;
      let linked;
      try {
        linked = await linkCentral(claims);
      } catch (err) {
        logger.error(`central-login: linking failed sub=${short(claims.sub)} client=app: ${err.message}`);
        return unavailable();
      }
      if (linked.outcome !== 'ok') return fail(res, linked.reason in STATUS ? linked.reason : 'signin_failed');
      userId = String(linked.user.id);
      knownName = linked.user.display_name || linked.user.name || null;
      try {
        const roles = Array.isArray(claims.roles) ? claims.roles.filter((r) => typeof r === 'string') : [];
        if (!result.refreshToken) logger.warn('[oidc] the IdP sent no refresh token (offline_access not granted?): this app session cannot be re-checked and ends after OIDC_MAX_UNVERIFIED_SECONDS');
        const s = await store.create({
          userId, sub: claims.sub, refreshToken: result.refreshToken, idToken: result.idToken, roles, prefix: MOBILE_TOKEN_PREFIX,
        });
        token = s.rawId;
      } catch (err) {
        logger.error(`[oidc] could not open an app session: ${err.message}`);
        return unavailable();
      }
      mode = 'central';
      // The app's previous session (sent along as the Bearer) is replaced.
      const previous = mobileBearer(req.headers);
      if (previous && CENTRAL_TOKEN_RE.test(previous) && previous !== token) {
        await store.remove(hashId(previous)).catch((err) => logger.error(`[oidc] could not end the previous app session: ${err.message}`));
      }
    }

    userAuth.invalidate(userId);
    try { account = await userAuth.getAccount(userId); } catch { account = null; }
    res.json({
      token,
      token_type: 'Bearer',
      expires_at: now() + SESSION_MAX_AGE_MS,
      mode,
      user: { id: userId, name: (account && account.name) || knownName, status: (account && account.status) || 'approved' },
    });
  });

  // ---- sign out --------------------------------------------------------------

  router.post('/auth/mobile/logout', limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = mobileBearer(req.headers);
    // Dev tokens are stateless: forgetting it on the phone is the sign-out.
    if (!token || devLogin || !CENTRAL_TOKEN_RE.test(token)) return res.json({ success: true });
    try {
      await store.remove(hashId(token));
    } catch (err) {
      logger.error('[oidc] app sign-out could not remove the session:', err.message);
      return res.status(503).json({ error: 'Could not sign out, try again', code: 'signin_unavailable' });
    }
    res.json({ success: true });
  });

  // ---- who am I --------------------------------------------------------------

  router.get('/api/me',
    (req, res, next) => (mobileBearer(req.headers) ? next() : next('route')),
    userAuth.requireLevel('member'),
    (req, res) => {
      const { account } = req._listenAuth;
      const name = account.name || '';
      res.set('Cache-Control', 'no-store');
      res.json({ name, user: { id: account.id, name, status: account.status }, session: { kind: 'app' } });
    });

  return router;
}

module.exports = { createMobileAuthRouter, MOBILE_REDIRECT_URI };
