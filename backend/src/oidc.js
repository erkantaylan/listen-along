/**
 * The central login's OIDC client (authorization code + PKCE S256 + state +
 * nonce), on openid-client v6. Everything protocol-shaped lives here; the
 * routes in index.js, the sessions in oidcSessions.js and the account linking
 * in oidcLink.js call it.
 *
 * - Discovery is lazy and retried: if the IdP is unreachable at boot the app
 *   starts anyway (bootCheck() only logs), and each later call tries again. A
 *   failed discovery is never cached. Metadata that cannot work (not JSON, a
 *   different issuer, no token endpoint, no S256) is fatal at boot.
 * - The browser half of a sign-in (state, nonce, PKCE verifier, the page to
 *   return to) rides in one short-lived cookie, encrypted and authenticated
 *   with a key derived from SESSION_SECRET (secretBox.js): HttpOnly,
 *   SameSite=Lax (the IdP's redirect back is a top-level GET), Path=/, 10
 *   minutes; named __Host-la_oidc_flow when Secure (production).
 * - The redirect URI is fixed from configuration (BASE_URL), never from the
 *   request's Host header, so it always matches the IdP's strict registration.
 * - Claims are read from the validated id_token only: openid-client checks
 *   issuer, audience, expiry and nonce, and (enableNonRepudiationChecks) the
 *   signature against the IdP's JWKS; it does not by default for tokens from
 *   the token endpoint, which the tests caught.
 *   authentik puts every scope's claims in the id_token
 *   (include_claims_in_id_token), so there is no userinfo call.
 */

const { deriveKey, seal, open } = require('./secretBox');

const FLOW_COOKIE = 'la_oidc_flow'; // the name without the __Host- prefix (see oidcConfig.js)
const FLOW_COOKIE_PATH = '/'; // __Host- cookies must be Path=/
const REFRESH_TIMEOUT_SECONDS = 3; // a re-check must never hold a request long
const FLOW_MAX_AGE_MS = 10 * 60 * 1000;
const FLOW_AAD = 'listen-along/oidc-flow';

/** Discovery failures that mean "the IdP is not reachable right now". */
const TRANSIENT_CODES = new Set(['OAUTH_RESPONSE_IS_NOT_CONFORM']);

class OidcError extends Error {
  /** @param {'fatal'|'unavailable'|'refused'|'invalid'} kind */
  constructor(kind, message, cause) {
    super(message);
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

function describe(err) {
  if (!err) return 'unknown error';
  const code = err.code || (err.cause && err.cause.code);
  const name = err.name && err.name !== 'Error' ? err.name : '';
  return [name, code, err.message].filter(Boolean).join(' ').slice(0, 300);
}

/** Network errors, timeouts and non-2xx answers: the IdP is down or busy, not misconfigured. */
function isTransient(err) {
  if (!err) return false;
  if (err instanceof TypeError) return true; // fetch failed (DNS, refused, reset, TLS)
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  // An OAuth error body with a 5xx / 429 status: busy or broken, not a "no".
  if (err.name === 'ResponseBodyError' && (err.status >= 500 || err.status === 429)) return true;
  if (err.cause && (err.cause.name === 'TimeoutError' || err.cause.name === 'AbortError')) return true;
  return false;
}

/**
 * @param cfg     readOidcConfig() result (enabled)
 * @param secret  SESSION_SECRET
 * @param timeoutSeconds  per HTTP call to the IdP
 */
function createOidcClient(cfg, { secret, timeoutSeconds = 10, logger = console } = {}) {
  if (!cfg || !cfg.enabled) throw new Error('createOidcClient: central login is not configured');
  const flowKey = deriveKey(secret, 'oidc-flow-cookie-v1');

  let libPromise = null;
  const lib = () => (libPromise ||= import('openid-client'));

  let configPromise = null;
  let refreshConfig = null; // same metadata, short timeout (refresh only)

  async function discover() {
    const client = await lib();
    const clientAuth = cfg.clientSecret ? client.ClientSecretBasic(cfg.clientSecret) : client.None();
    const metadata = cfg.clientSecret ? { client_secret: cfg.clientSecret } : undefined;
    let config;
    try {
      config = await client.discovery(cfg.issuer, cfg.clientId, metadata, clientAuth, {
        timeout: timeoutSeconds,
        // Verify id_token signatures against the IdP's JWKS too (openid-client
        // otherwise relies on TLS for tokens from the token endpoint).
        execute: [client.enableNonRepudiationChecks, ...(cfg.allowInsecure ? [client.allowInsecureRequests] : [])],
      });
    } catch (err) {
      throw new OidcError(isTransient(err) ? 'unavailable' : 'fatal', `discovery of ${cfg.issuer.href} failed: ${describe(err)}`, err);
    }
    const md = config.serverMetadata();
    const missing = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'].filter((k) => typeof md[k] !== 'string' || !md[k]);
    if (missing.length) throw new OidcError('fatal', `the IdP's metadata has no ${missing.join(', ')}`);
    if (Array.isArray(md.code_challenge_methods_supported) && !md.code_challenge_methods_supported.includes('S256')) {
      throw new OidcError('fatal', 'the IdP does not support PKCE S256');
    }
    // A twin of the configuration for re-checks, with a short timeout: an IdP
    // that hangs must not stall users' requests for the discovery's 10 s.
    const twin = new client.Configuration({ ...md }, cfg.clientId, metadata, clientAuth);
    client.enableNonRepudiationChecks(twin);
    if (cfg.allowInsecure) client.allowInsecureRequests(twin);
    twin.timeout = REFRESH_TIMEOUT_SECONDS;
    refreshConfig = twin;
    if (!md.end_session_endpoint) {
      logger.warn('[oidc] the IdP publishes no end_session_endpoint: sign-out will end the local session only');
    }
    return config;
  }

  /** The discovered configuration; a failure is not cached, so the next call retries. */
  function configuration() {
    if (!configPromise) {
      const p = discover();
      configPromise = p;
      p.catch(() => { if (configPromise === p) configPromise = null; });
    }
    return configPromise;
  }

  /**
   * At boot: discovery that answers with metadata that cannot work throws
   * (fatal); an IdP that cannot be reached is logged and retried later.
   */
  async function bootCheck() {
    try {
      const config = await configuration();
      const md = config.serverMetadata();
      logger.log(`[oidc] central login on: issuer ${md.issuer}, client ${cfg.clientId}, scopes "${cfg.scopes}"`);
      return true;
    } catch (err) {
      if (err instanceof OidcError && err.kind === 'fatal') throw err;
      logger.warn(`[oidc] the IdP is not reachable at boot (${describe(err)}); starting anyway, sign-in retries discovery`);
      return false;
    }
  }

  // ---- the browser half of a sign-in ------------------------------------

  function sealFlow(flow) {
    return seal(flowKey, JSON.stringify(flow), FLOW_AAD);
  }

  /** The flow from the cookie value, or null (missing, forged, expired). */
  function openFlow(value, now = Date.now()) {
    if (!value) return null;
    let raw = value;
    try { raw = decodeURIComponent(value); } catch {}
    const json = open(flowKey, raw, FLOW_AAD);
    if (!json) return null;
    let f;
    try { f = JSON.parse(json); } catch { return null; }
    if (!f || typeof f.state !== 'string' || typeof f.nonce !== 'string' || typeof f.verifier !== 'string') return null;
    if (typeof f.t !== 'number' || f.t > now + 60_000 || now - f.t > FLOW_MAX_AGE_MS) return null;
    return { state: f.state, nonce: f.nonce, verifier: f.verifier, next: typeof f.next === 'string' ? f.next : '/' };
  }

  /**
   * Start a sign-in. `next` must already be a validated same-origin path.
   * @returns {{ url: string, flowCookie: string }}
   */
  async function startLogin({ next = '/' } = {}) {
    const client = await lib();
    const config = await configuration();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: cfg.redirectUri,
      scope: cfg.scopes,
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, flowCookie: sealFlow({ state, nonce, verifier, next, t: Date.now() }) };
  }

  /**
   * Finish a sign-in: exchange the code and validate the id_token.
   * @param query   the callback's raw query string (with or without "?")
   * @param flow    openFlow() result
   * @returns {{ claims: object, refreshToken: string|null, idToken: string|null }}
   * @throws OidcError('invalid'|'unavailable')
   */
  async function finishLogin(query, flow) {
    if (!flow) throw new OidcError('invalid', 'no sign-in in progress (flow cookie missing, expired or forged)');
    const client = await lib();
    let config;
    try { config = await configuration(); } catch (err) { throw new OidcError('unavailable', describe(err), err); }
    // The registered redirect URI plus the IdP's answer (code, state, iss or error).
    const current = new URL(cfg.redirectUri);
    current.search = String(query || '').replace(/^\?/, '');
    let tokens;
    try {
      tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      throw new OidcError(isTransient(err) ? 'unavailable' : 'invalid', describe(err), err);
    }
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) {
      throw new OidcError('invalid', 'the id_token has no usable sub');
    }
    // Only tokens issued to listen-along alone (openid-client allows extra
    // audiences when azp names us; this app does not).
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (aud.length !== 1 || aud[0] !== cfg.clientId) throw new OidcError('invalid', 'the id_token has another or an extra audience');
    if (claims.azp !== undefined && claims.azp !== cfg.clientId) throw new OidcError('invalid', 'the id_token was issued to another party (azp)');
    return { claims, refreshToken: tokens.refresh_token || null, idToken: tokens.id_token || null };
  }

  /**
   * Refresh-token grant for a session's re-check (short timeout).
   * @returns {{ refreshToken: string, idToken: string|null, claims: object|null }}
   * @throws OidcError:
   *   'refused'      end the session: invalid_grant (account disabled
   *                  centrally, token revoked or expired), or an answer whose
   *                  id_token does not validate or names another sub
   *   'misconfigured' keep the session, log loudly: any other OAuth error
   *                  (invalid_client, unauthorized_client...): the IdP or this
   *                  app is set up wrong; users are not to blame
   *   'unavailable'  keep the session: no answer (network, timeout, 5xx, 429)
   */
  async function refresh(refreshToken, { expectedSub } = {}) {
    const client = await lib();
    try { await configuration(); } catch (err) { throw new OidcError('unavailable', describe(err), err); }
    let t;
    try {
      t = await client.refreshTokenGrant(refreshConfig, refreshToken);
    } catch (err) {
      if (err instanceof client.ResponseBodyError && !isTransient(err)) {
        if (err.error === 'invalid_grant') throw new OidcError('refused', `${err.status} invalid_grant`, err);
        throw new OidcError('misconfigured', `${err.status} ${err.error || 'error'}`, err);
      }
      if (isTransient(err)) throw new OidcError('unavailable', describe(err), err);
      throw new OidcError('refused', `the refresh answer did not validate: ${describe(err)}`, err);
    }
    const claims = t.id_token ? t.claims() : null;
    if (claims && expectedSub && claims.sub !== expectedSub) {
      throw new OidcError('refused', 'the refreshed id_token names a different sub');
    }
    // Rotation: keep the old token only if the IdP did not send a new one.
    return { refreshToken: t.refresh_token || refreshToken, idToken: t.id_token || null, claims };
  }

  /** Where to send the browser after the local session is gone (RP-initiated logout). */
  async function endSessionUrl(idToken) {
    try {
      const client = await lib();
      const config = await configuration();
      if (!config.serverMetadata().end_session_endpoint) return null;
      const params = { post_logout_redirect_uri: cfg.postLogoutRedirectUri };
      if (idToken) params.id_token_hint = idToken;
      return client.buildEndSessionUrl(config, params).href;
    } catch (err) {
      logger.warn(`[oidc] no end-session URL (${describe(err)}); signing out locally only`);
      return null;
    }
  }

  return { configuration, bootCheck, startLogin, finishLogin, refresh, endSessionUrl, openFlow, cfg };
}

module.exports = { createOidcClient, OidcError, FLOW_COOKIE, FLOW_COOKIE_PATH, FLOW_MAX_AGE_MS, REFRESH_TIMEOUT_SECONDS, isTransient, describe };
