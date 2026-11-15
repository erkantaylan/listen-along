/**
 * Central login (OIDC) settings, read from the environment. Pure: no network.
 *
 * Central login is ON when both OIDC_ISSUER and OIDC_CLIENT_ID are set, and
 * then it REPLACES Google / GitHub sign-in. With neither set the app works
 * exactly as before (the rollback switch). One without the other, or a value
 * that cannot work, is a configuration error: readOidcConfig() throws and the
 * server refuses to start (index.js), so a half-configured deploy is loud.
 *
 *   OIDC_ISSUER        https://id.example.com/application/o/listen-along/
 *   OIDC_CLIENT_ID     listen-along
 *   OIDC_CLIENT_SECRET optional; listen-along is a public client (PKCE only)
 *   OIDC_SCOPES        default "openid email profile entitlements offline_access";
 *                      add "upstream" once the IdP maps upstream_identities
 *   OIDC_PROVIDER_MAP  optional "slug=provider,..." from upstream_identities'
 *                      provider slugs to listen-along's provider names;
 *                      google and github map to themselves by default
 *   OIDC_RECHECK_SECONDS        how often a session is re-checked with the
 *                               refresh token (default 300)
 *   OIDC_MAX_UNVERIFIED_SECONDS how long a session may go without a successful
 *                               re-check while the IdP is unreachable
 *                               (default 86400 = 24 h)
 *   BASE_URL (else FRONTEND_URL) the public address; the redirect URI is
 *                      <BASE_URL>/auth/oidc/callback, never the Host header
 *   SESSION_SECRET     required in central-login mode (encrypts the stored
 *                      refresh tokens and the sign-in flow cookie)
 */

const DEFAULT_SCOPES = 'openid email profile entitlements offline_access';
const DEFAULT_PROVIDER_MAP = Object.freeze({ google: 'google', github: 'github' });
const CALLBACK_PATH = '/auth/oidc/callback';

class OidcConfigError extends Error {}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

function positiveSeconds(env, name, fallback) {
  const raw = trimmed(env[name]);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new OidcConfigError(`${name} must be a positive number of seconds (got "${raw}")`);
  return n;
}

/** "google=google,gh=github" -> { google: 'google', github: 'github', gh: 'github' } */
function parseProviderMap(raw) {
  const map = { ...DEFAULT_PROVIDER_MAP };
  if (!raw) return map;
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const m = item.match(/^([a-z0-9_.-]{1,50})\s*=\s*([a-z0-9_.-]{1,20})$/i);
    if (!m) throw new OidcConfigError(`OIDC_PROVIDER_MAP: "${item}" is not slug=provider`);
    map[m[1].toLowerCase()] = m[2].toLowerCase();
  }
  return map;
}

function parseUrl(name, value) {
  let u;
  try { u = new URL(value); } catch { throw new OidcConfigError(`${name} is not a URL: "${value}"`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new OidcConfigError(`${name} must be http(s): "${value}"`);
  if (u.username || u.password) throw new OidcConfigError(`${name} must not carry credentials`);
  return u;
}

/**
 * @returns {{enabled: false} | {enabled: true, issuer: URL, clientId, clientSecret, scopes,
 *   baseUrl, redirectUri, postLogoutRedirectUri, providerMap, recheckMs, maxUnverifiedMs,
 *   allowInsecure}}
 * @throws OidcConfigError when half-configured or a value cannot work
 */
function readOidcConfig(env = process.env) {
  const issuerRaw = trimmed(env.OIDC_ISSUER);
  const clientId = trimmed(env.OIDC_CLIENT_ID);
  if (!issuerRaw && !clientId) return { enabled: false };
  if (!issuerRaw || !clientId) {
    throw new OidcConfigError(`central login is half-configured: set both OIDC_ISSUER and OIDC_CLIENT_ID, or neither (missing ${issuerRaw ? 'OIDC_CLIENT_ID' : 'OIDC_ISSUER'})`);
  }
  const production = env.NODE_ENV === 'production';
  const issuer = parseUrl('OIDC_ISSUER', issuerRaw);
  if (issuer.search || issuer.hash) throw new OidcConfigError('OIDC_ISSUER must not have a query or fragment');
  if (production && issuer.protocol !== 'https:') throw new OidcConfigError('OIDC_ISSUER must be https in production');

  if (!trimmed(env.SESSION_SECRET)) {
    throw new OidcConfigError('SESSION_SECRET must be set when central login is on (it encrypts the stored sign-in tokens)');
  }

  const baseRaw = trimmed(env.BASE_URL) || trimmed(env.FRONTEND_URL);
  if (!baseRaw) throw new OidcConfigError('BASE_URL (or FRONTEND_URL) must be set to the public address when central login is on');
  const base = parseUrl(env.BASE_URL ? 'BASE_URL' : 'FRONTEND_URL', baseRaw);
  if (base.search || base.hash) throw new OidcConfigError('BASE_URL must not have a query or fragment');
  if (production && base.protocol !== 'https:') throw new OidcConfigError('BASE_URL must be https in production (the IdP compares the redirect URI exactly)');
  const baseUrl = base.href.replace(/\/+$/, '');

  const scopes = (trimmed(env.OIDC_SCOPES) || DEFAULT_SCOPES).split(/\s+/).filter(Boolean);
  if (!scopes.includes('openid')) throw new OidcConfigError('OIDC_SCOPES must include "openid"');
  for (const s of scopes) if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)) throw new OidcConfigError(`OIDC_SCOPES: invalid scope "${s}"`);

  // Secure cookies in production (as the old login cookie decides). Then they
  // carry the __Host- prefix: Secure, Path=/, no Domain, so no other host or
  // path can set or shadow them.
  const secureCookies = production;
  const cookieName = (base) => (secureCookies ? `__Host-${base}` : base);

  return {
    enabled: true,
    secureCookies,
    sessionCookie: cookieName('la_session'),
    flowCookie: cookieName('la_oidc_flow'),
    issuer,
    clientId,
    clientSecret: trimmed(env.OIDC_CLIENT_SECRET) || null,
    scopes: [...new Set(scopes)].join(' '),
    // `upstream` requested: an id_token without upstream_identities means the
    // IdP mapping is missing (index.js warns).
    upstreamExpected: scopes.includes('upstream'),
    baseUrl,
    redirectUri: baseUrl + CALLBACK_PATH,
    postLogoutRedirectUri: baseUrl + '/',
    providerMap: parseProviderMap(trimmed(env.OIDC_PROVIDER_MAP)),
    recheckMs: positiveSeconds(env, 'OIDC_RECHECK_SECONDS', 300) * 1000,
    maxUnverifiedMs: positiveSeconds(env, 'OIDC_MAX_UNVERIFIED_SECONDS', 24 * 60 * 60) * 1000,
    // Plain-http issuers only outside production (a local IdP, the tests' fake one).
    allowInsecure: issuer.protocol === 'http:',
  };
}

module.exports = { readOidcConfig, OidcConfigError, DEFAULT_SCOPES, DEFAULT_PROVIDER_MAP, CALLBACK_PATH, parseProviderMap };
