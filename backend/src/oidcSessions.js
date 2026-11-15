/**
 * Server-side sessions for central login (OIDC; the only sign-in in
 * production. The dev sign-in, devLogin.js, has none).
 *
 * The browser holds only `la_session` (`__Host-la_session` when Secure, in
 * production): 32 random bytes, opaque. The server
 * stores the SHA-256 of it (never the id itself), the user, the central `sub`,
 * the refresh token and id_token ENCRYPTED (AES-256-GCM, key from
 * SESSION_SECRET via HKDF, bound to the row by its id hash: secretBox.js), the
 * roles claim (kept for later; it gates nothing today), and the times.
 * Postgres `user_sessions`; a Map without a database.
 *
 * The Android app's sessions (mobileAuth.js) are rows in the same table: the
 * app holds `lam_` + 32 random bytes and sends it as a Bearer token
 * (resolveBearer); the hash covers the prefix. Same lifetime, re-check and
 * ban handling as a browser's.
 *
 * Lifetime: 30 days from sign-in (as the old cookie), never extended.
 *
 * Re-check: when a session is used and its last successful check is older than
 * OIDC_RECHECK_SECONDS (5 min), the refresh token is used once (single-flight
 * per session: concurrent requests wait for the same refresh; rotation keeps
 * the newest token; 3 s timeout):
 *   - invalid_grant (account disabled centrally, token revoked or expired), or
 *     an answer whose id_token does not validate or names another sub -> the
 *     session ends, its sockets are cut
 *   - any other OAuth error (invalid_client...: misconfiguration) -> kept,
 *     logged as an error
 *   - no answer (network, timeout, 5xx, 429) -> the session is kept and the
 *     check retried after RETRY_AFTER_MS (and nobody's for IDP_QUIET_MS), so
 *     an IdP outage signs nobody out and stalls little, until the session
 *     has gone OIDC_MAX_UNVERIFIED_SECONDS (24 h) without a successful check:
 *     then it ends (fail closed)
 *   - a session without a refresh token (the IdP did not grant
 *     offline_access) cannot be re-checked and ends at that same cap
 * Long-lived sockets are re-checked by a timer in index.js (checkSession).
 */

const crypto = require('crypto');
const { deriveKey, seal, open } = require('./secretBox');
const { parseCookie } = require('./userAuth');
const { CENTRAL_TOKEN_RE } = require('./mobileTokens');

const SESSION_COOKIE = 'la_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// After a re-check the IdP did not answer: that session is not tried again for
// RETRY_AFTER_MS, and no session at all for IDP_QUIET_MS (min with the
// re-check interval), so an outage costs each session at most one short
// (3 s, oidc.js) wait per 5 minutes instead of stalling every request.
const RETRY_AFTER_MS = 5 * 60 * 1000;
const IDP_QUIET_MS = 30 * 1000;

const hashId = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const newRawId = () => crypto.randomBytes(32).toString('base64url');
const RAW_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * @param dbExpected DATABASE_URL is set: then a missing pool is an outage, and
 *   the store fails closed instead of falling back to memory (memory is only
 *   for the genuine no-database dev mode).
 */
function createSessionStore({ db, secret, dbExpected = false }) {
  const key = deriveKey(secret, 'oidc-session-tokens-v1');
  const memory = new Map();
  const usePg = () => {
    if (db && db.isAvailable()) return true;
    if (dbExpected) throw new Error('the database is unavailable');
    return false;
  };

  const enc = (idHash, v) => (v ? seal(key, v, idHash) : null);
  // undefined = stored but cannot be opened (another SESSION_SECRET): broken
  const dec = (idHash, v) => (v ? (open(key, v, idHash) ?? undefined) : null);

  function fromRow(r) {
    if (!r) return null;
    const refreshToken = dec(r.id_hash, r.refresh_token_enc);
    const idToken = dec(r.id_hash, r.id_token_enc);
    return {
      idHash: r.id_hash,
      userId: String(r.user_id),
      sub: r.oidc_sub,
      refreshToken: refreshToken || null,
      idToken: idToken || null,
      tokensBroken: refreshToken === undefined || idToken === undefined,
      roles: Array.isArray(r.roles) ? r.roles : [],
      createdAt: Number(r.created_at),
      lastCheckedAt: Number(r.last_checked_at),
      expiresAt: Number(r.expires_at),
    };
  }

  // `prefix`: 'lam_' for the Android app's Bearer sessions (mobileTokens.js);
  // the stored hash covers the prefix, so a cookie id is never a Bearer.
  async function create({ userId, sub, refreshToken, idToken, roles, prefix = '', now = Date.now() }) {
    const rawId = prefix + newRawId();
    const idHash = hashId(rawId);
    const row = {
      id_hash: idHash,
      user_id: String(userId),
      oidc_sub: sub,
      refresh_token_enc: enc(idHash, refreshToken),
      id_token_enc: enc(idHash, idToken),
      roles: Array.isArray(roles) ? roles : [],
      created_at: now,
      last_checked_at: now,
      expires_at: now + SESSION_MAX_AGE_MS,
    };
    if (usePg()) {
      await db.query(
        `INSERT INTO user_sessions (id_hash, user_id, oidc_sub, refresh_token_enc, id_token_enc, roles, created_at, last_checked_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [row.id_hash, row.user_id, row.oidc_sub, row.refresh_token_enc, row.id_token_enc, JSON.stringify(row.roles), row.created_at, row.last_checked_at, row.expires_at]
      );
    } else {
      memory.set(idHash, row);
    }
    return { rawId, idHash, maxAgeMs: SESSION_MAX_AGE_MS };
  }

  async function get(idHash) {
    if (!usePg()) return fromRow(memory.get(idHash));
    const r = await db.query('SELECT * FROM user_sessions WHERE id_hash = $1', [idHash]);
    return fromRow(r.rows[0]);
  }

  async function markChecked(idHash, { refreshToken, idToken, roles, at = Date.now() }) {
    const rt = enc(idHash, refreshToken);
    const it = idToken ? enc(idHash, idToken) : null;
    const rolesJson = Array.isArray(roles) ? JSON.stringify(roles) : null;
    if (!usePg()) {
      const row = memory.get(idHash);
      if (!row) return false;
      row.refresh_token_enc = rt;
      if (it) row.id_token_enc = it;
      if (rolesJson) row.roles = roles;
      row.last_checked_at = at;
      return true;
    }
    const r = await db.query(
      `UPDATE user_sessions SET refresh_token_enc = $2, id_token_enc = COALESCE($3, id_token_enc),
         roles = COALESCE($4::jsonb, roles), last_checked_at = $5 WHERE id_hash = $1`,
      [idHash, rt, it, rolesJson, at]
    );
    return r.rowCount > 0;
  }

  async function remove(idHash) {
    if (!usePg()) return memory.delete(idHash);
    const r = await db.query('DELETE FROM user_sessions WHERE id_hash = $1', [idHash]);
    return r.rowCount > 0;
  }

  /** Every session of one account (an admin banned it). @returns the removed id hashes */
  async function removeForUser(userId) {
    if (!usePg()) {
      const gone = [];
      for (const [h, row] of memory) if (row.user_id === String(userId)) { memory.delete(h); gone.push(h); }
      return gone;
    }
    const r = await db.query('DELETE FROM user_sessions WHERE user_id::text = $1 RETURNING id_hash', [String(userId)]);
    return r.rows.map((x) => x.id_hash);
  }

  async function purgeExpired(now = Date.now()) {
    if (!usePg()) {
      let n = 0;
      for (const [h, row] of memory) if (row.expires_at <= now) { memory.delete(h); n++; }
      return n;
    }
    const r = await db.query('DELETE FROM user_sessions WHERE expires_at <= $1', [now]);
    return r.rowCount;
  }

  return { create, get, markChecked, remove, removeForUser, purgeExpired };
}

/**
 * @param store    createSessionStore()
 * @param client   createOidcClient() (refresh)
 * @param cfg      readOidcConfig() (recheckMs, maxUnverifiedMs)
 * @param onEnded  (idHash, reason) -> void: a session ended by a check (cut its sockets)
 */
function createOidcSessions({ store, client, cfg, cookieName = SESSION_COOKIE, onEnded = () => {}, logger = console, now = () => Date.now() }) {
  const inflight = new Map(); // idHash -> Promise<session|null>
  const retryAt = new Map();  // idHash -> ms: an unanswered refresh is retried after this
  let quietUntil = 0;         // no refresh for anyone before this (the IdP just failed)
  const quietMs = Math.min(IDP_QUIET_MS, cfg.recheckMs);
  const short = (h) => String(h).slice(0, 8);

  async function end(idHash, reason) {
    retryAt.delete(idHash);
    try { await store.remove(idHash); } catch (err) { logger.error(`[oidc] could not delete session ${short(idHash)}: ${err.message}`); }
    logger.log(`[oidc] session ${short(idHash)} ended: ${reason}`);
    try { onEnded(idHash, reason); } catch {}
  }

  async function recheck(s) {
    const t = now();
    if (!s.refreshToken) {
      if (t - s.lastCheckedAt > cfg.maxUnverifiedMs) { await end(s.idHash, 'no refresh token, unverified too long'); return null; }
      return s;
    }
    let r;
    try {
      r = await client.refresh(s.refreshToken, { expectedSub: s.sub });
    } catch (err) {
      if (err && err.kind === 'refused') {
        await end(s.idHash, `the IdP refused the refresh (${err.message})`);
        return null;
      }
      if (t - s.lastCheckedAt > cfg.maxUnverifiedMs) {
        await end(s.idHash, `the IdP has not confirmed it for over ${Math.round(cfg.maxUnverifiedMs / 1000)}s (${err && err.message})`);
        return null;
      }
      retryAt.set(s.idHash, t + RETRY_AFTER_MS);
      quietUntil = t + quietMs;
      if (err && err.kind === 'misconfigured') {
        logger.error(`[oidc] CONFIGURATION PROBLEM: the IdP rejected the refresh with ${err.message} (not invalid_grant): session ${short(s.idHash)} kept; check OIDC_CLIENT_ID / the IdP provider`);
      } else {
        logger.warn(`[oidc] re-check of session ${short(s.idHash)} postponed, the IdP did not answer: ${err && err.message}`);
      }
      return s;
    }
    retryAt.delete(s.idHash);
    const roles = r.claims && Array.isArray(r.claims.roles) ? r.claims.roles.filter((x) => typeof x === 'string') : null;
    const ok = await store.markChecked(s.idHash, { refreshToken: r.refreshToken, idToken: r.idToken, roles, at: t });
    if (!ok) return null; // deleted meanwhile (logout, ban)
    return { ...s, refreshToken: r.refreshToken, idToken: r.idToken || s.idToken, roles: roles || s.roles, lastCheckedAt: t };
  }

  /**
   * The live session for an id hash, re-checked with the IdP when due; null
   * when there is none (or it just ended). Throws only on a storage error.
   */
  async function check(idHash, { recheckIfDue = true } = {}) {
    if (inflight.has(idHash)) return inflight.get(idHash);
    const s = await store.get(idHash);
    if (!s) return null;
    const t = now();
    if (s.expiresAt <= t) { await end(idHash, 'expired'); return null; }
    if (s.tokensBroken) { await end(idHash, 'stored tokens cannot be decrypted (SESSION_SECRET changed?)'); return null; }
    if (!recheckIfDue || t - s.lastCheckedAt < cfg.recheckMs) return s;
    if ((retryAt.get(idHash) || 0) > t || quietUntil > t) {
      if (t - s.lastCheckedAt > cfg.maxUnverifiedMs) { await end(idHash, 'unverified too long'); return null; }
      return s;
    }
    if (inflight.has(idHash)) return inflight.get(idHash);
    const p = recheck(s).finally(() => inflight.delete(idHash));
    inflight.set(idHash, p);
    return p;
  }

  function idHashFromHeaders(headers) {
    const raw = parseCookie(headers && headers.cookie, cookieName);
    if (!raw || !RAW_ID_RE.test(raw)) return null;
    return hashId(raw);
  }

  /** The session behind a request's / handshake's `la_session` cookie, or null. */
  async function resolveHeaders(headers, opts) {
    const idHash = idHashFromHeaders(headers);
    return idHash ? check(idHash, opts) : null;
  }

  /** The Android app's `lam_` Bearer token -> its id hash, or null when malformed. */
  function idHashFromBearer(token) {
    return typeof token === 'string' && CENTRAL_TOKEN_RE.test(token) ? hashId(token) : null;
  }

  /** The session behind an app's `lam_` Bearer token (same store, same re-check), or null. */
  async function resolveBearer(token, opts) {
    const idHash = idHashFromBearer(token);
    return idHash ? check(idHash, opts) : null;
  }

  return { check, resolveHeaders, idHashFromHeaders, resolveBearer, idHashFromBearer, end };
}

module.exports = { createSessionStore, createOidcSessions, SESSION_COOKIE, SESSION_MAX_AGE_MS, RETRY_AFTER_MS, IDP_QUIET_MS, hashId };
