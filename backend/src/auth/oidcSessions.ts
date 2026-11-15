/**
 * Server-side sessions for central login (OIDC; the only sign-in in
 * production. The dev sign-in, devLogin.ts, has none).
 *
 * The browser holds only `la_session` (`__Host-la_session` when Secure, in
 * production): 32 random bytes, opaque. The server
 * stores the SHA-256 of it (never the id itself), the user, the central `sub`,
 * the refresh token and id_token ENCRYPTED (AES-256-GCM, key from
 * SESSION_SECRET via HKDF, bound to the row by its id hash: shared/secretBox.ts), the
 * roles claim (kept for later; it gates nothing today), and the times.
 * Postgres `user_sessions`; a Map without a database.
 *
 * The Android app's sessions (mobileAuth.ts) are rows in the same table: the
 * app holds `lam_` + 32 random bytes and sends it as a Bearer token
 * (resolveBearer); the hash covers the prefix. Same lifetime, re-check and
 * ban handling as a browser's.
 *
 * Lifetime: 30 days from sign-in (as the old cookie), never extended.
 *
 * Re-check: when a session is used and its last successful check is older than
 * OIDC_RECHECK_SECONDS (5 min), the refresh token is used once (single-flight
 * per session: concurrent requests wait for the same refresh, and a request
 * whose read of the row started before a refresh finished does not start
 * another with the token that refresh rotated away; rotation keeps the newest
 * token; 3 s timeout):
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
 * Long-lived sockets are re-checked by a timer in app/sockets.ts (checkSession).
 */

import crypto from 'crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { deriveKey, seal, open } from '../shared/secretBox.ts';
import { parseCookie } from './userAuth.ts';
import { CENTRAL_TOKEN_RE } from './mobileTokens.ts';
import type { Db } from '../shared/types.ts';
import type { OidcClient } from './oidc.ts';
import type { OidcConfigOn } from './oidcConfig.ts';
import type { Logger, Session, UserSessionRow } from './types.ts';

export const SESSION_COOKIE = 'la_session';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// After a re-check the IdP did not answer: that session is not tried again for
// RETRY_AFTER_MS, and no session at all for IDP_QUIET_MS (min with the
// re-check interval), so an outage costs each session at most one short
// (3 s, oidc.ts) wait per 5 minutes instead of stalling every request.
export const RETRY_AFTER_MS = 5 * 60 * 1000;
export const IDP_QUIET_MS = 30 * 1000;

export const hashId = (raw: unknown): string => crypto.createHash('sha256').update(String(raw)).digest('hex');
const newRawId = (): string => crypto.randomBytes(32).toString('base64url');
const RAW_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A session row as the store keeps it: from Postgres (BIGINTs as strings) or
 * in memory (numbers), read the same way by fromRow().
 */
type StoredRow = Omit<UserSessionRow, 'created_at' | 'last_checked_at' | 'expires_at'> & {
  created_at: string | number;
  last_checked_at: string | number;
  expires_at: string | number;
};
/** In memory (no database): the times are numbers. */
type MemoryRow = StoredRow & { created_at: number; last_checked_at: number; expires_at: number };

/** What the store uses of the database (shared/db.ts). */
export type SessionStoreDb = Pick<Db, 'isAvailable' | 'query'>;

/** What a new session hands back: the raw id (cookie value or `lam_` token), its hash and its lifetime. */
export interface CreatedSession {
  rawId: string;
  idHash: string;
  maxAgeMs: number;
}

/** What createSessionStore() returns. Every method throws when the database is expected but missing. */
export interface SessionStore {
  create(s: { userId: unknown; sub: string; refreshToken: string | null; idToken: string | null; roles?: unknown; prefix?: string; now?: number }): Promise<CreatedSession>;
  get(idHash: string): Promise<Session | null>;
  markChecked(idHash: string, s: { refreshToken: string | null; idToken: string | null; roles: unknown; at?: number }): Promise<boolean>;
  remove(idHash: string): Promise<boolean>;
  removeForUser(userId: unknown): Promise<string[]>;
  purgeExpired(now?: number): Promise<number | null>;
}

/**
 * @param dbExpected DATABASE_URL is set: then a missing pool is an outage, and
 *   the store fails closed instead of falling back to memory (memory is only
 *   for the genuine no-database dev mode).
 */
export function createSessionStore({ db, secret, dbExpected = false }: {
  db: SessionStoreDb | null;
  secret: string;
  dbExpected?: boolean;
}): SessionStore {
  const key = deriveKey(secret, 'oidc-session-tokens-v1');
  const memory = new Map<string, MemoryRow>();
  const usePg = () => {
    if (db && db.isAvailable()) return true;
    if (dbExpected) throw new Error('the database is unavailable');
    return false;
  };

  const enc = (idHash: string, v: string | null | undefined): string | null => (v ? seal(key, v, idHash) : null);
  // undefined = stored but cannot be opened (another SESSION_SECRET): broken
  const dec = (idHash: string, v: string | null): string | null | undefined => (v ? (open(key, v, idHash) ?? undefined) : null);

  function fromRow(r: StoredRow | undefined): Session | null {
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

  // `prefix`: 'lam_' for the Android app's Bearer sessions (mobileTokens.ts);
  // the stored hash covers the prefix, so a cookie id is never a Bearer.
  async function create({ userId, sub, refreshToken, idToken, roles, prefix = '', now = Date.now() }: Parameters<SessionStore['create']>[0]): Promise<CreatedSession> {
    const rawId = prefix + newRawId();
    const idHash = hashId(rawId);
    const row: MemoryRow = {
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
      await db!.query(
        `INSERT INTO user_sessions (id_hash, user_id, oidc_sub, refresh_token_enc, id_token_enc, roles, created_at, last_checked_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [row.id_hash, row.user_id, row.oidc_sub, row.refresh_token_enc, row.id_token_enc, JSON.stringify(row.roles), row.created_at, row.last_checked_at, row.expires_at]
      );
    } else {
      memory.set(idHash, row);
    }
    return { rawId, idHash, maxAgeMs: SESSION_MAX_AGE_MS };
  }

  async function get(idHash: string): Promise<Session | null> {
    if (!usePg()) return fromRow(memory.get(idHash));
    const r = await db!.query<UserSessionRow>('SELECT * FROM user_sessions WHERE id_hash = $1', [idHash]);
    return fromRow(r.rows[0]);
  }

  async function markChecked(idHash: string, { refreshToken, idToken, roles, at = Date.now() }: Parameters<SessionStore['markChecked']>[1]): Promise<boolean> {
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
    const r = await db!.query(
      `UPDATE user_sessions SET refresh_token_enc = $2, id_token_enc = COALESCE($3, id_token_enc),
         roles = COALESCE($4::jsonb, roles), last_checked_at = $5 WHERE id_hash = $1`,
      [idHash, rt, it, rolesJson, at]
    );
    return r.rowCount! > 0;
  }

  async function remove(idHash: string): Promise<boolean> {
    if (!usePg()) return memory.delete(idHash);
    const r = await db!.query('DELETE FROM user_sessions WHERE id_hash = $1', [idHash]);
    return r.rowCount! > 0;
  }

  /** Every session of one account (an admin banned it). @returns the removed id hashes */
  async function removeForUser(userId: unknown): Promise<string[]> {
    if (!usePg()) {
      const gone: string[] = [];
      for (const [h, row] of memory) if (row.user_id === String(userId)) { memory.delete(h); gone.push(h); }
      return gone;
    }
    const r = await db!.query<{ id_hash: string }>('DELETE FROM user_sessions WHERE user_id::text = $1 RETURNING id_hash', [String(userId)]);
    return r.rows.map((x) => x.id_hash);
  }

  async function purgeExpired(now: number = Date.now()): Promise<number | null> {
    if (!usePg()) {
      let n = 0;
      for (const [h, row] of memory) if (row.expires_at <= now) { memory.delete(h); n++; }
      return n;
    }
    const r = await db!.query('DELETE FROM user_sessions WHERE expires_at <= $1', [now]);
    return r.rowCount;
  }

  return { create, get, markChecked, remove, removeForUser, purgeExpired };
}

/** What createOidcSessions() returns. */
export interface OidcSessions {
  /** The live session for an id hash, re-checked when due; null when there is none. Throws only on a storage error. */
  check(idHash: string, opts?: { recheckIfDue?: boolean }): Promise<Session | null>;
  resolveHeaders(headers: IncomingHttpHeaders | null | undefined, opts?: { recheckIfDue?: boolean }): Promise<Session | null>;
  idHashFromHeaders(headers: IncomingHttpHeaders | null | undefined): string | null;
  resolveBearer(token: unknown, opts?: { recheckIfDue?: boolean }): Promise<Session | null>;
  idHashFromBearer(token: unknown): string | null;
  end(idHash: string, reason: string): Promise<void>;
}

/**
 * @param store    createSessionStore()
 * @param client   createOidcClient() (refresh)
 * @param cfg      readOidcConfig() (recheckMs, maxUnverifiedMs)
 * @param onEnded  (idHash, reason) -> void: a session ended by a check (cut its sockets)
 */
export function createOidcSessions({ store, client, cfg, cookieName = SESSION_COOKIE, onEnded = () => {}, logger = console, now = () => Date.now() }: {
  store: SessionStore;
  client: Pick<OidcClient, 'refresh'>;
  cfg: Pick<OidcConfigOn, 'recheckMs' | 'maxUnverifiedMs'>;
  cookieName?: string;
  onEnded?: (idHash: string, reason: string) => void;
  logger?: Logger;
  now?: () => number;
}): OidcSessions {
  const inflight = new Map<string, Promise<Session | null>>(); // idHash -> Promise<session|null>
  // idHash -> when this process last re-checked it successfully. A request that
  // read the row while that re-check ran holds the old lastCheckedAt and the
  // old refresh token; using that token again would be a reuse, and the IdP
  // ends the session for it (invalid_grant).
  const checkedAt = new Map<string, number>();
  const retryAt = new Map<string, number>();  // idHash -> ms: an unanswered refresh is retried after this
  let quietUntil = 0;         // no refresh for anyone before this (the IdP just failed)
  const quietMs = Math.min(IDP_QUIET_MS, cfg.recheckMs);
  const short = (h: string) => String(h).slice(0, 8);

  async function end(idHash: string, reason: string): Promise<void> {
    retryAt.delete(idHash);
    try { await store.remove(idHash); } catch (err) { logger.error(`[oidc] could not delete session ${short(idHash)}: ${(err as Error).message}`); }
    logger.log(`[oidc] session ${short(idHash)} ended: ${reason}`);
    try { onEnded(idHash, reason); } catch {}
  }

  async function recheck(s: Session): Promise<Session | null> {
    const t = now();
    if (!s.refreshToken) {
      if (t - s.lastCheckedAt > cfg.maxUnverifiedMs) { await end(s.idHash, 'no refresh token, unverified too long'); return null; }
      return s;
    }
    let r: Awaited<ReturnType<OidcClient['refresh']>>;
    try {
      r = await client.refresh(s.refreshToken, { expectedSub: s.sub });
    } catch (caught) {
      // An OidcError from client.refresh (kind, message), or anything else that was thrown.
      const err = caught as { kind?: string; message?: string } | null | undefined;
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
    const roles: string[] | null = r.claims && Array.isArray(r.claims.roles) ? r.claims.roles.filter((x) => typeof x === 'string') : null;
    const ok = await store.markChecked(s.idHash, { refreshToken: r.refreshToken, idToken: r.idToken, roles, at: t });
    if (!ok) return null; // deleted meanwhile (logout, ban)
    if (checkedAt.size > 10000) checkedAt.clear();
    checkedAt.set(s.idHash, t);
    return { ...s, refreshToken: r.refreshToken, idToken: r.idToken || s.idToken, roles: roles || s.roles, lastCheckedAt: t };
  }

  /**
   * The live session for an id hash, re-checked with the IdP when due; null
   * when there is none (or it just ended). Throws only on a storage error.
   */
  async function check(idHash: string, { recheckIfDue = true }: { recheckIfDue?: boolean } = {}): Promise<Session | null> {
    if (inflight.has(idHash)) return inflight.get(idHash)!;
    const s = await store.get(idHash);
    if (!s) return null;
    const t = now();
    if (s.expiresAt <= t) { await end(idHash, 'expired'); return null; }
    if (s.tokensBroken) { await end(idHash, 'stored tokens cannot be decrypted (SESSION_SECRET changed?)'); return null; }
    const lastChecked = Math.max(s.lastCheckedAt, checkedAt.get(idHash) || 0);
    if (!recheckIfDue || t - lastChecked < cfg.recheckMs) return s;
    checkedAt.delete(idHash);
    if ((retryAt.get(idHash) || 0) > t || quietUntil > t) {
      if (t - s.lastCheckedAt > cfg.maxUnverifiedMs) { await end(idHash, 'unverified too long'); return null; }
      return s;
    }
    if (inflight.has(idHash)) return inflight.get(idHash)!;
    const p = recheck(s).finally(() => inflight.delete(idHash));
    inflight.set(idHash, p);
    return p;
  }

  function idHashFromHeaders(headers: IncomingHttpHeaders | null | undefined): string | null {
    const raw = parseCookie(headers && headers.cookie, cookieName);
    if (!raw || !RAW_ID_RE.test(raw)) return null;
    return hashId(raw);
  }

  /** The session behind a request's / handshake's `la_session` cookie, or null. */
  async function resolveHeaders(headers: IncomingHttpHeaders | null | undefined, opts?: { recheckIfDue?: boolean }): Promise<Session | null> {
    const idHash = idHashFromHeaders(headers);
    return idHash ? check(idHash, opts) : null;
  }

  /** The Android app's `lam_` Bearer token -> its id hash, or null when malformed. */
  function idHashFromBearer(token: unknown): string | null {
    return typeof token === 'string' && CENTRAL_TOKEN_RE.test(token) ? hashId(token) : null;
  }

  /** The session behind an app's `lam_` Bearer token (same store, same re-check), or null. */
  async function resolveBearer(token: unknown, opts?: { recheckIfDue?: boolean }): Promise<Session | null> {
    const idHash = idHashFromBearer(token);
    return idHash ? check(idHash, opts) : null;
  }

  return { check, resolveHeaders, idHashFromHeaders, resolveBearer, idHashFromBearer, end };
}
