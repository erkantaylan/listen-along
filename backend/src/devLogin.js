/**
 * Development / test sign-in: the only way in besides the central login, and
 * never in production.
 *
 *   INSECURE_DEV_LOGIN=1   turns it on. Refused at boot (readDevLogin throws,
 *                          index.js exits) unless NODE_ENV is exactly
 *                          `development` or `test`, and when central login
 *                          (OIDC_ISSUER + OIDC_CLIENT_ID) is set too: one way
 *                          in at a time. Anything but empty / 0 / 1 is refused.
 *
 * Then the login cookie is `la_dev_login`: `<base64url {id, t}>.<sig>`, HMAC
 * with SESSION_SECRET under its own label (so nothing signed for another
 * purpose, the old `listen_auth` cookie included, ever verifies as one). `id`
 * is users.id, `t` the sign-in time; 30 days. `GET /auth/dev/login` sets it
 * (index.js), the tests sign it directly (testServer.js cookieFor).
 */

const crypto = require('crypto');

const DEV_COOKIE = 'la_dev_login';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const LABEL = 'listen-along-dev-login-v1.';
const ALLOWED_NODE_ENVS = new Set(['development', 'test']);

class DevLoginError extends Error {}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * @returns {boolean} whether dev sign-in is on
 * @throws DevLoginError when it is asked for where it must not run
 */
function readDevLogin(env = process.env) {
  const raw = trimmed(env.INSECURE_DEV_LOGIN);
  if (!raw || raw === '0') return false;
  if (raw !== '1') throw new DevLoginError(`INSECURE_DEV_LOGIN must be 1 or empty (got "${raw}")`);
  const nodeEnv = trimmed(env.NODE_ENV);
  if (nodeEnv === 'production') {
    throw new DevLoginError('INSECURE_DEV_LOGIN is refused in production (NODE_ENV=production): it lets anyone sign in as anyone');
  }
  if (!ALLOWED_NODE_ENVS.has(nodeEnv)) {
    throw new DevLoginError(`INSECURE_DEV_LOGIN needs NODE_ENV=development or NODE_ENV=test (got "${nodeEnv || 'unset'}")`);
  }
  if (trimmed(env.OIDC_ISSUER) || trimmed(env.OIDC_CLIENT_ID)) {
    throw new DevLoginError('INSECURE_DEV_LOGIN and central login (OIDC_ISSUER / OIDC_CLIENT_ID) cannot both be on: pick one');
  }
  return true;
}

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(LABEL + payload).digest('base64url');

/** The `la_dev_login` cookie value for users.id `userId`. */
function signDevToken(secret, userId, t = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** @returns {{id, t}|null} */
function verifyDevToken(secret, token, now = Date.now()) {
  if (!secret || !token || typeof token !== 'string' || token.length > 2048) return null;
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(secret, payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data || (typeof data.id !== 'string' && typeof data.id !== 'number') || data.id === '') return null;
  if (typeof data.t !== 'number' || !Number.isFinite(data.t)) return null;
  if (data.t > now + CLOCK_SKEW_MS || now - data.t > MAX_AGE_MS) return null;
  return data;
}

module.exports = { DEV_COOKIE, MAX_AGE_MS, DevLoginError, readDevLogin, signDevToken, verifyDevToken };
