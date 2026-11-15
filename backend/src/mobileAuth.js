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
 *   GET  /auth/mobile/start?state&nonce&code_challenge&code_challenge_method=S256[&redirect_uri]
 *        The app opens this in a Custom Tab. It made state, nonce and the PKCE
 *        verifier itself and keeps them. `redirect_uri` says where the IdP is to
 *        send the code, one of exactly two (anything else is refused):
 *          <BASE_URL>/auth/mobile/callback    the https App Link (verified by
 *                                             Android through assetlinks.json:
 *                                             only this app's signing key gets it)
 *          com.etaylan.listen:/oauth2redirect the custom scheme (any app can
 *                                             claim it); the default when the
 *                                             parameter is missing (app 0.4.0
 *                                             and older); MOBILE_CUSTOM_SCHEME=off
 *                                             refuses it
 *        Central login: 302 to the IdP's authorize endpoint with that
 *        redirect_uri, the server's scopes, and a nonce derived from the app's
 *        nonce and the redirect (idpNonce, below; a consistency check, not a
 *        secret: it is in this Location header). The IdP sends the browser
 *        back with ?code&state (or ?error). Dev sign-in: a page whose link goes
 *        straight back to the app with a signed dev code.
 *   GET  /auth/mobile/callback?code&state   the https redirect's target. When
 *        Android has verified the App Link it opens the app and this is never
 *        requested. Otherwise (not verified yet, no app, a desktop browser): a
 *        static page whose button hands the same query to the app through an
 *        intent: URL naming the package. It exchanges nothing, the code never
 *        appears in the HTML (the page's script reads location.search), the
 *        query stays out of the access log (httpApp.js), no-store, no referrer.
 *   GET  /.well-known/assetlinks.json   the Digital Asset Links statement that
 *        lets Android verify the App Link: package + release signing
 *        certificate (ANDROID_APP_PACKAGE, ANDROID_APP_CERT_SHA256).
 *   POST /auth/mobile/exchange  { code, state, code_verifier, nonce, iss?, redirect_uri? }
 *        redirect_uri: the one the sign-in was started with (same allowlist,
 *        same default). It goes to the IdP's token endpoint and into the
 *        derived nonce the id_token must carry, so start and exchange must
 *        name the same redirect. That is NOT proof of the redirect the IdP
 *        actually sent the code to (see "What stops what").
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
 *   - another app that STARTS its own flow on the custom scheme and catches
 *     the code for the victim's existing IdP browser session (PKCE does not
 *     help: it holds its own verifier): the https App Link, which Android
 *     gives only to the app signed with the key in assetlinks.json (on
 *     Android 12+; see CENTRAL-LOGIN.md for 8-11), and then REMOVING the
 *     custom scheme from the IdP client's redirect URIs (central-login
 *     catalog), so the IdP issues no code to it at all. Only that removal
 *     closes this. MOBILE_CUSTOM_SCHEME=off is its server-side companion
 *     (old apps get "update the app"), not the fix: authentik checks only
 *     that the token request's redirect_uri is registered, not that it is the
 *     one the code was issued for, and the id_token says nothing about the
 *     redirect, so no server-only check can tell which redirect really
 *     delivered a code. With the scheme still registered, an attacker asks
 *     /start for the https redirect, copies the derived nonce out of the
 *     Location header into its own authorize URL on the scheme (its own
 *     PKCE), and exchanges the caught code naming the https redirect: the
 *     server accepts it (tested: mobile-auth.test.js "the limit").
 *   - what idpNonce does buy: start and exchange must name the same redirect
 *     (a mixed-up client fails), and the nonce must have come out of /start
 *     (an authorize URL with a nonce of the caller's own fails). A
 *     consistency check; it is no secret and no proof of the redirect used.
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
const { make: makeLimiter } = require('./shared/rateLimits.ts');
const { linkCentralIdentity, centralName } = require('./oidcLink');
const { hashId, SESSION_MAX_AGE_MS } = require('./oidcSessions');
const { deriveKey } = require('./shared/secretBox.ts');
const {
  MOBILE_TOKEN_PREFIX, CENTRAL_TOKEN_RE, mobileBearer, signDevMobileToken, signDevCode, verifyDevCode, s256,
} = require('./auth/mobileTokens.ts');

/** The custom scheme registered with the IdP for the listen-along client (central-login catalog). */
const MOBILE_REDIRECT_URI = 'com.etaylan.listen:/oauth2redirect';
/** The https redirect is <BASE_URL> + this: an Android App Link (assetlinks.json). */
const MOBILE_CALLBACK_PATH = '/auth/mobile/callback';
const ASSET_LINKS_PATH = '/.well-known/assetlinks.json';

/**
 * The Android app's package and the SHA-256 of its RELEASE signing
 * certificate, as `apksigner verify --print-certs` prints it for the signed
 * APK of the GitHub Release android-v0.3.0 (CN=Listen Along, O=listen-along;
 * the key of .github/workflows/android-release.yml). Public, not a secret.
 * ANDROID_APP_PACKAGE / ANDROID_APP_CERT_SHA256 replace them, so a rotated key
 * needs no code change. Debug builds (`.debug`, a per-machine debug key) are
 * not listed: they keep the custom scheme.
 */
const DEFAULT_APP_PACKAGE = 'com.erkantaylan.listenalong';
const RELEASE_CERT_SHA256 = 'DD:B6:D8:FE:68:09:7B:E1:50:5D:53:37:55:EE:3C:59:D1:65:E6:E3:18:52:DB:BA:9C:C6:A6:5F:45:61:C3:F5';
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const FINGERPRINT_RE = /^(?:[0-9A-Fa-f]{64}|[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31})$/;

class MobileConfigError extends Error {
  get name() { return 'MobileConfigError'; }
}

/** "ddb6...f5" or "DD:B6:...:F5" -> "DD:B6:...:F5"; null when it is not 32 bytes of hex. */
function normalizeFingerprint(raw) {
  const text = String(raw).trim();
  if (!FINGERPRINT_RE.test(text)) return null;
  return text.replace(/:/g, '').toUpperCase().match(/../g).join(':');
}

/**
 * The app sign-in's settings, read at boot; a bad value throws
 * MobileConfigError and the server does not start.
 *
 *   MOBILE_CUSTOM_SCHEME     on (default) | off: whether the custom-scheme
 *                            redirect is still accepted (app 0.4.0 and older
 *                            use it). Switch it off TOGETHER with removing the
 *                            scheme from the IdP client, which is what closes
 *                            the risk; off alone only turns old apps away
 *                            (CENTRAL-LOGIN.md "The redirect").
 *   ANDROID_APP_PACKAGE      the release package (default DEFAULT_APP_PACKAGE)
 *   ANDROID_APP_CERT_SHA256  comma-separated SHA-256 certificate fingerprints
 *                            (hex, colons optional) for that package;
 *                            `package=FINGERPRINT` names another package (a
 *                            debug build, deliberately, for testing). Replaces
 *                            the default: list the release one too.
 *
 * @param baseUrl  the public address (BASE_URL) or null; the https redirect is
 *                 <baseUrl>/auth/mobile/callback, never from the Host header
 * @returns {{ customScheme: boolean, callbackUrl: string|null, appPackage: string,
 *             assetLinks: object[], redirects: string[] }}
 */
function readMobileConfig(env = process.env, { baseUrl = null } = {}) {
  const switchRaw = String(env.MOBILE_CUSTOM_SCHEME || '').trim().toLowerCase();
  if (!['', 'on', 'off'].includes(switchRaw)) {
    throw new MobileConfigError(`MOBILE_CUSTOM_SCHEME must be "on" or "off" (got "${env.MOBILE_CUSTOM_SCHEME}")`);
  }
  const customScheme = switchRaw !== 'off';

  const appPackage = String(env.ANDROID_APP_PACKAGE || '').trim() || DEFAULT_APP_PACKAGE;
  if (!PACKAGE_RE.test(appPackage) || appPackage.length > 255) {
    throw new MobileConfigError(`ANDROID_APP_PACKAGE is not an Android package name: "${appPackage}"`);
  }

  const byPackage = new Map();
  for (const item of (String(env.ANDROID_APP_CERT_SHA256 || '').trim() || RELEASE_CERT_SHA256).split(',')) {
    const entry = item.trim();
    if (!entry) throw new MobileConfigError('ANDROID_APP_CERT_SHA256 has an empty entry');
    const eq = entry.indexOf('=');
    const pkg = eq === -1 ? appPackage : entry.slice(0, eq).trim();
    const fp = normalizeFingerprint(eq === -1 ? entry : entry.slice(eq + 1));
    if (!PACKAGE_RE.test(pkg)) throw new MobileConfigError(`ANDROID_APP_CERT_SHA256: "${pkg}" is not an Android package name`);
    if (!fp) throw new MobileConfigError(`ANDROID_APP_CERT_SHA256: "${entry}" is not a SHA-256 fingerprint (64 hex digits, colons optional)`);
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    if (!byPackage.get(pkg).includes(fp)) byPackage.get(pkg).push(fp);
  }
  const assetLinks = [...byPackage].map(([pkg, fps]) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps },
  }));

  const base = typeof baseUrl === 'string' && baseUrl ? baseUrl.replace(/\/+$/, '') : null;
  const callbackUrl = base ? base + MOBILE_CALLBACK_PATH : null;
  if (!customScheme && !callbackUrl) {
    throw new MobileConfigError('MOBILE_CUSTOM_SCHEME=off needs BASE_URL: the app would have no redirect left');
  }
  const redirects = [callbackUrl, customScheme ? MOBILE_REDIRECT_URI : null].filter(Boolean);
  return { customScheme, callbackUrl, appPackage, assetLinks, redirects };
}

/** BASE_URL (or FRONTEND_URL) for the dev sign-in, which readOidcConfig does not read; null when unset or not http(s). */
function devBaseUrl(env) {
  const raw = String(env.BASE_URL || env.FRONTEND_URL || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.search = '';
    u.hash = '';
    return u.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** HKDF purpose label of the nonce key (secretBox.deriveKey), so it is no other key made from SESSION_SECRET. */
const NONCE_KEY_PURPOSE = 'listen-along/mobile-nonce/v1';
const nonceKeys = new Map(); // secret -> derived key (one secret per process; tests use a few)

/**
 * The nonce the IdP is given (and the id_token must carry) for an app sign-in:
 * HMAC over the redirect and the app's nonce, with a key derived from
 * SESSION_SECRET. A CONSISTENCY CHECK, NOT A SECRET OR A BINDING to the
 * redirect the IdP used: /auth/mobile/start hands it to anyone in its Location
 * header. What it gives: the exchange must name the same redirect as the start,
 * and the nonce must have come out of /start (a hand-built authorize URL with a
 * nonce of its own fails). What it does not: anyone can take it from /start
 * for one redirect and use it in an authorize request on the other; only the
 * IdP's registered redirect URIs decide which redirects can receive a code.
 */
function idpNonce(secret, nonce, redirectUri) {
  const s = String(secret);
  let key = nonceKeys.get(s);
  if (!key) {
    key = deriveKey(s, NONCE_KEY_PURPOSE);
    if (nonceKeys.size > 16) nonceKeys.clear();
    nonceKeys.set(s, key);
  }
  return crypto.createHmac('sha256', key).update(`${redirectUri}\n${nonce}`).digest('base64url');
}

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
    `border:1px solid #444;background:#1f2229;color:inherit}p.muted{color:#9aa0ab;font-size:14px}[hidden]{display:none!important}</style></head>` +
    `<body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`
  );
}

const appRedirect = (redirectUri, params) => `${redirectUri}?${new URLSearchParams(params)}`;

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
  if (!secret) throw new Error('createMobileAuthRouter: SESSION_SECRET is required (it keys the app sign-in nonce)');
  const config = readMobileConfig(env, { baseUrl: cfg.enabled ? cfg.baseUrl : devBaseUrl(env) });
  const router = express.Router();

  /**
   * The redirect the app says it uses: a value of the allowlist, the custom
   * scheme when none is given (older apps), or null = refused (unknown, or the
   * custom scheme while it is switched off).
   */
  function chosenRedirect(raw) {
    if (raw === undefined || raw === null) return config.customScheme ? MOBILE_REDIRECT_URI : null;
    if (typeof raw !== 'string') return null;
    return config.redirects.includes(raw) ? raw : null;
  }
  /** Refused because it is (or defaults to) the switched-off custom scheme: an old app. */
  const isOldApp = (raw) => raw === undefined || raw === null || raw === MOBILE_REDIRECT_URI;

  // ---- App Links: the statement and the fallback page ----------------------

  const assetLinksBody = JSON.stringify(config.assetLinks, null, 2) + '\n';
  router.get(ASSET_LINKS_PATH, (req, res) => {
    // Android fetches it at install and on re-verification; cached briefly so
    // a rotated key is served within minutes.
    res.set('Cache-Control', 'public, max-age=300').type('application/json').send(assetLinksBody);
  });

  // The page Android shows instead of opening the app when the link is not
  // verified (or there is no app). Static: the script reads code and state
  // from location.search and only puts them into the intent: link of the
  // button, which names the app's package (so no other app can take it, even
  // unverified). Nothing is exchanged or sent from here.
  const callbackTarget = config.callbackUrl ? new URL(config.callbackUrl) : null;
  const intentPrefix = callbackTarget ? `intent://${callbackTarget.host}${callbackTarget.pathname}` : '';
  const intentSuffix = callbackTarget
    ? `#Intent;scheme=${callbackTarget.protocol.slice(0, -1)};package=${config.appPackage};` +
      `S.browser_fallback_url=${encodeURIComponent(new URL('/app', callbackTarget).href)};end`
    : '';
  const inScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  router.get(MOBILE_CALLBACK_PATH, (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex');
    if (!callbackTarget) return page(res, 404, 'Not found', '<p>This server has no app sign-in link.</p>');
    return page(res, 200, 'Continue in the app',
      '<p>Sign-in continues in the Listen Along app. Tap the button to go back to it.</p>' +
      '<p lang="tr">Giriş Listen Along uygulamasında devam ediyor. Uygulamaya dönmek için düğmeye dokunun.</p>' +
      '<p><a class="button" id="open-app" href="#" hidden>Open the app · Uygulamayı aç</a></p>' +
      '<p class="muted" id="no-signin" hidden>There is no sign-in to continue here. Start it again in the app.<br>' +
      '<span lang="tr">Burada sürdürülecek bir giriş yok. Uygulamadan yeniden başlatın.</span></p>' +
      '<p class="muted">This works only on the phone that started the sign-in, with the app installed.<br>' +
      '<span lang="tr">Yalnızca girişi başlatan, uygulamanın yüklü olduğu telefonda çalışır.</span></p>' +
      '<script>(function () {' +
      'var q = location.search.slice(1), p = new URLSearchParams(q);' +
      'var ok = q.length <= 4096 && /^[A-Za-z0-9._~%=&+-]+$/.test(q) && p.get("state") && (p.get("code") || p.get("error"));' +
      'if (!ok) { document.getElementById("no-signin").hidden = false; return; }' +
      'var a = document.getElementById("open-app");' +
      `a.href = ${inScript(intentPrefix)} + "?" + q + ${inScript(intentSuffix)};` +
      'a.hidden = false;' +
      '})();</script>');
  });

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
    const redirectUri = chosenRedirect(q.redirect_uri);
    if (!redirectUri) {
      if (isOldApp(q.redirect_uri)) {
        return page(res, 400, 'Update the app',
          '<p>This version of the Listen Along app signs in in a way this server no longer accepts. Install the latest version, then sign in again.</p>' +
          '<p lang="tr">Listen Along uygulamasının bu sürümü, bu sunucunun artık kabul etmediği bir yolla giriş yapıyor. En son sürümü yükleyip yeniden giriş yapın.</p>');
      }
      return page(res, 400, 'Sign-in link not valid', '<p>Go back to the app and tap Sign in again.</p>');
    }
    const nonceForIdp = idpNonce(secret, nonce, redirectUri); // consistency, not secrecy (idpNonce)

    if (devLogin) {
      const asked = typeof q.user === 'string' ? q.user.trim().slice(0, 100) : '';
      const code = signDevCode(secret, { user: asked || null, challenge, nonce: nonceForIdp }, now());
      const hidden = { state, nonce, code_challenge: challenge, code_challenge_method: 'S256' };
      if (typeof q.redirect_uri === 'string') hidden.redirect_uri = redirectUri;
      return page(res, 200, 'Development sign-in',
        '<p class="muted">This server runs with INSECURE_DEV_LOGIN: anyone can sign in as anyone. Development only.</p>' +
        `<p><a class="button" id="continue" href="${escapeHtml(appRedirect(redirectUri, { code, state }))}">Continue as ${escapeHtml(asked ? `user ${asked}` : 'Dev User')}</a></p>` +
        '<form method="get" action="/auth/mobile/start"><p class="muted">Or as another account (users.id):</p>' +
        Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('') +
        '<input name="user" placeholder="users.id" autocomplete="off"> <button type="submit">Use it</button></form>');
    }

    try {
      const url = await oidc.authorizationUrl({ redirectUri, state, nonce: nonceForIdp, codeChallenge: challenge });
      res.set('Cache-Control', 'no-store');
      return res.redirect(url);
    } catch (err) {
      logger.error(`[oidc] could not start an app sign-in: ${err.message}`);
      return page(res, 503, 'Sign-in unavailable',
        '<p>Sign-in cannot be reached right now. Try again in a little while.</p>' +
        `<p><a class="button" href="${escapeHtml(appRedirect(redirectUri, { error: 'temporarily_unavailable', state }))}">Back to the app</a></p>`);
    }
  });

  // ---- exchange ------------------------------------------------------------

  /** Central login: the code -> claims + tokens, validated as at the web callback. */
  async function exchangeCentral(b, redirectUri) {
    const query = new URLSearchParams({ code: b.code, state: b.state });
    if (b.iss) query.set('iss', b.iss);
    const flow = { state: b.state, nonce: idpNonce(secret, b.nonce, redirectUri), verifier: b.code_verifier };
    return oidc.finishLogin(query.toString(), flow, { redirectUri });
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
    // The redirect the sign-in was started with: the same allowlist and
    // default as start. Refused before the code is spent.
    const redirectUri = chosenRedirect(b.redirect_uri);
    if (!redirectUri) {
      return fail(res, 'invalid_request', isOldApp(b.redirect_uri) ? 'This version of the app can no longer sign in here: install the latest version' : undefined);
    }

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
      if (!c || c.nonce !== idpNonce(secret, b.nonce, redirectUri) || s256(b.code_verifier) !== c.challenge) return fail(res, 'signin_failed');
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
        result = await exchangeCentral(b, redirectUri);
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

module.exports = {
  createMobileAuthRouter, readMobileConfig, idpNonce, normalizeFingerprint, MobileConfigError,
  MOBILE_REDIRECT_URI, MOBILE_CALLBACK_PATH, ASSET_LINKS_PATH, DEFAULT_APP_PACKAGE, RELEASE_CERT_SHA256,
};
