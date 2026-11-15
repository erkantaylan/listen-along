/**
 * The Android app's session token: what the app sends as
 * `Authorization: Bearer lam_...` after signing in through the central login
 * (mobileAuth.js). Pure: no I/O, nothing of the app imported, so userAuth.js, tokens.ts and
 * oidcSessions.js can all use it without a require cycle.
 *
 * The prefix `lam_` ("listen-along mobile") never collides with a CLI token
 * (`la_` + base64url: a CLI token's third character is always `_`, a mobile
 * token's is `m`). tokens.ts treats a
 * `lam_` Bearer as "not a CLI token", userAuth.js as a user session.
 *
 * Two shapes, one per sign-in mode (fixed at boot):
 *   central login  `lam_` + 43 base64url chars (32 random bytes): a row in
 *                  user_sessions, stored as the SHA-256 of the WHOLE string
 *                  (prefix included), so a web cookie's id is never a valid
 *                  Bearer and a Bearer is never a valid cookie.
 *   dev sign-in    `lam_` + `<base64url {id, t}>.<HMAC>`: stateless, like the
 *                  la_dev_login cookie, under its own HMAC label, 30 days.
 *                  Only exists while INSECURE_DEV_LOGIN is on (never in
 *                  production: the server refuses to start with it there).
 */

import crypto from 'crypto';

/** A request's / handshake's headers, as far as the Bearer token goes. */
export interface AuthHeaders {
  authorization?: string | string[];
}

/** A dev sign-in session token's content: users.id and the sign-in time (ms). */
export type DevMobileToken = {
  id: string;
  t: number;
};

/** A dev sign-in "authorization code", opened. */
export interface DevCode {
  /** users.id asked for on the dev page, or null (the Dev User) */
  user: string | null;
  challenge: string;
  nonce: string;
  t: number;
}

export const MOBILE_TOKEN_PREFIX = 'lam_';
/** A central-login mobile session token. */
export const CENTRAL_TOKEN_RE = /^lam_[A-Za-z0-9_-]{43}$/;
const DEV_TOKEN_LABEL = 'listen-along-dev-mobile-session-v1.';
const DEV_CODE_LABEL = 'listen-along-dev-mobile-code-v1.';
const DEV_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEV_CODE_MAX_AGE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function isMobileToken(token: unknown): boolean {
  return typeof token === 'string' && token.startsWith(MOBILE_TOKEN_PREFIX);
}

/** The `lam_...` Bearer token of a request's / handshake's headers, or null (none, or another kind). */
export function mobileBearer(headers: AuthHeaders | null | undefined): string | null {
  const header = headers && headers.authorization;
  if (typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(\S+)\s*$/i);
  return m && isMobileToken(m[1]) ? m[1] : null;
}

const hmac = (secret: string, label: string, payload: string): string => crypto.createHmac('sha256', secret).update(label + payload).digest('base64url');

function signLabelled(secret: string, label: string, data: object): string {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${hmac(secret, label, payload)}`;
}

/** The object signed under `label`, or null (forged, malformed, too old, from the future). */
function verifyLabelled(secret: string, label: string, value: string, maxAgeMs: number, now: number = Date.now()): ({ t: number } & Record<string, unknown>) | null {
  if (!secret || typeof value !== 'string' || value.length > 4096) return null;
  const idx = value.indexOf('.');
  if (idx <= 0) return null;
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = hmac(secret, label, payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  // Parsed JSON, checked below before it is returned.
  let data: Record<string, unknown> | null;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data || typeof data !== 'object' || typeof data.t !== 'number' || !Number.isFinite(data.t)) return null;
  if (data.t > now + CLOCK_SKEW_MS || now - data.t > maxAgeMs) return null;
  return data as { t: number } & Record<string, unknown>;
}

/** Dev sign-in: the session token for users.id `userId`. */
export function signDevMobileToken(secret: string, userId: string, t: number = Date.now()): string {
  return MOBILE_TOKEN_PREFIX + signLabelled(secret, DEV_TOKEN_LABEL, { id: String(userId), t });
}

/** Dev sign-in: { id, t } from a valid token, else null. */
export function verifyDevMobileToken(secret: string, token: string, now: number = Date.now()): DevMobileToken | null {
  if (!isMobileToken(token)) return null;
  const data = verifyLabelled(secret, DEV_TOKEN_LABEL, token.slice(MOBILE_TOKEN_PREFIX.length), DEV_TOKEN_MAX_AGE_MS, now);
  return data && typeof data.id === 'string' && data.id ? (data as DevMobileToken) : null;
}

/** Dev sign-in: the one-time "authorization code" the dev page hands to the app. */
export function signDevCode(secret: string, { user, challenge, nonce }: { user: string | null; challenge: string; nonce: string }, t: number = Date.now()): string {
  return 'dev.' + signLabelled(secret, DEV_CODE_LABEL, { u: user || null, c: challenge, n: nonce, t });
}

export function verifyDevCode(secret: string, code: unknown, now: number = Date.now()): DevCode | null {
  if (typeof code !== 'string' || !code.startsWith('dev.')) return null;
  const data = verifyLabelled(secret, DEV_CODE_LABEL, code.slice(4), DEV_CODE_MAX_AGE_MS, now);
  if (!data || typeof data.c !== 'string' || typeof data.n !== 'string') return null;
  return { user: typeof data.u === 'string' && data.u ? data.u : null, challenge: data.c, nonce: data.n, t: data.t };
}

/** PKCE S256 (RFC 7636): base64url(SHA-256(verifier)). */
export function s256(verifier: unknown): string {
  return crypto.createHash('sha256').update(String(verifier)).digest('base64url');
}

