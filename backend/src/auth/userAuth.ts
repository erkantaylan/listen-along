/**
 * Who is making a request, and what they may reach. The one place that turns
 * a request (or a socket handshake's headers) into a user id: resolve(),
 * userIdFor(), identify().
 *
 * One way in, fixed at boot (index.js):
 *
 * - Central login (`sessions` given; OIDC_ISSUER + OIDC_CLIENT_ID; the only
 *   one in production): identity is the opaque `la_session` cookie, looked up
 *   server-side and re-checked with the IdP (oidcSessions.js).
 * - Dev login (`devLogin: true`; INSECURE_DEV_LOGIN=1, refused at boot unless
 *   NODE_ENV is development or test; devLogin.ts): identity is the
 *   HMAC-signed `la_dev_login` cookie holding users.id.
 *
 * The Android app (mobileAuth.js) is a user session too, carried as
 * `Authorization: Bearer lam_...` instead of a cookie (mobileTokens.ts): in
 * central mode a row of the same session store (same re-check, same ban
 * handling), in dev mode a signed token. For HTTP requests only (who()):
 * socket handshakes stay cookie-only, the app has no socket. When a `lam_`
 * Bearer is sent it is the ONLY identity looked at (no fallback to a cookie),
 * and a refusal for want of a session says `SESSION_ENDED` (401), which the
 * app takes as "sign in again". It reaches what a browser session reaches,
 * at the same account levels; admin stays the separate la_admin cookie, and
 * CLI-token-only routes refuse it (tokens.ts, 403 TOKEN_REQUIRED).
 *
 * The old Google / GitHub `listen_auth` cookie is no login in either mode:
 * nothing here reads it.
 *
 * Account status (users.status) decides how far a logged-in user gets:
 *
 *   approved          everything (playlists, queue, library, streaming, ...)
 *   pending (or any   the global chat / people panel, their own profile and
 *   unknown status)   /api/auth/me. Nothing else.
 *   denied, rejected  nothing but /api/auth/me and logging out. Sockets are
 *                     refused at the handshake.
 *
 * Without a database there is no users table: a signed-in user counts as an
 * approved account (same as social.js).
 *
 * Levels used by requireLevel() / policyFor():
 *   'login'    a valid cookie naming an existing account (any status)
 *   'member'   ... that is not denied / rejected (approved or pending)
 *   'approved' ... whose status is 'approved'
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Request, RequestHandler } from 'express';
import { DEV_COOKIE, verifyDevToken } from './devLogin.ts';
import { mobileBearer, verifyDevMobileToken } from './mobileTokens.ts';
import type { Db, UserRow } from '../shared/types.ts';
import type { Account, Identity, Level, Policy, Who } from './types.ts';

// What who() / identify() keep on a request, so it is looked up once.
declare module 'express-serve-static-core' {
  interface Request {
    /** who(): the signed-in user behind the cookie or the app's Bearer, or null */
    _listenWho?: Who | null;
    /** who(): the caller sent the Android app's `lam_` Bearer (then it is the only identity looked at) */
    _listenMobile?: boolean;
    /** identify(): the account, or nobody */
    _listenAuth?: Identity;
  }
}

/** The central login's sessions as userAuth uses them (oidcSessions.createOidcSessions). */
export interface SessionLookup {
  resolveHeaders(headers: IncomingHttpHeaders): Promise<{ userId: string; idHash: string } | null>;
  resolveBearer(token: string): Promise<{ userId: string; idHash: string } | null>;
}

/** What userAuth uses of the database (shared/db.ts). */
export type UserAuthDb = Pick<Db, 'isAvailable' | 'query'>;

/** An HTTP refusal: status and JSON body. */
export interface Refusal {
  status: 401 | 403;
  body: { error: string; code: 'SESSION_ENDED' | 'AUTH_REQUIRED' | 'ACCOUNT_DENIED' | 'ACCOUNT_PENDING' };
}

const BLOCKED_STATUSES: ReadonlySet<unknown> = new Set(['denied', 'rejected']);

export function parseCookie(header: unknown, name: string): string | null {
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function isBlocked(status: string | null | undefined): boolean {
  return BLOCKED_STATUSES.has(status);
}

export function meetsLevel(account: Account | null, level: Level): boolean {
  if (!account) return false;
  if (level === 'login') return true;
  if (level === 'member') return !isBlocked(account.status);
  if (level === 'approved') return account.status === 'approved';
  return false;
}

/**
 * HTTP status + JSON body for an account that does not meet `level`.
 * `mobile`: the caller sent the Android app's `lam_` Bearer token, so no
 * account means that session is unknown, expired, signed out or ended by a
 * re-check or a ban: SESSION_ENDED (the app goes back to its sign-in).
 */
export function refusal(account: Account | null, { mobile = false }: { mobile?: boolean } = {}): Refusal {
  if (!account && mobile) return { status: 401, body: { error: 'Your session has ended, sign in again', code: 'SESSION_ENDED' } };
  if (!account) return { status: 401, body: { error: 'Authentication required', code: 'AUTH_REQUIRED' } };
  if (isBlocked(account.status)) return { status: 403, body: { error: 'Access denied', code: 'ACCOUNT_DENIED' } };
  return { status: 403, body: { error: 'Your account is pending approval', code: 'ACCOUNT_PENDING' } };
}

// --- Route policy --------------------------------------------------------
// Deny by default: every path not listed here needs an approved account
// (/api/...) or a login (pages). Listed paths are either public or
// authenticate themselves with per-route middleware (CLI Bearer token, admin
// cookie, or "token or admin or approved user").

const PUBLIC_EXACT: ReadonlySet<string> = new Set([
  '/health',
  '/login',
  '/changelog',
  '/admin',
  '/api/version',
  '/api/changelog',
  '/api/auth/me',
  '/api/auth/register', // legacy: answers the caller's own status only
  '/api/auth/status',   // legacy: same
  '/api/auth/providers',
  '/api/auth/logout',
  '/api/admin/status',
  '/api/admin/login',
  '/api/admin/logout',
  // Central login (OIDC) round trip; 404 unless it is configured.
  '/auth/oidc/login',
  '/auth/oidc/callback',
  // The Android app's sign-in (mobileAuth.js): start, code exchange, sign-out,
  // the App Link's fallback page and the statement Android verifies it with.
  '/auth/mobile/start',
  '/auth/mobile/exchange',
  '/auth/mobile/logout',
  '/auth/mobile/callback',
  '/.well-known/assetlinks.json',
  // Dev sign-in (devLogin.js); 404 unless INSECURE_DEV_LOGIN is on.
  '/auth/dev/login',
]);

const PUBLIC_PREFIXES: readonly string[] = [
  '/lobby/',                // 301 to /playlist/..., which is guarded
];

// Routes with their own middleware (see index.js / libraryRoutes.js).
const SELF_EXACT: ReadonlySet<string> = new Set(['/api/me', '/api/library', '/api/requests', '/dashboard', '/api/auth/users']);
const SELF_PREFIXES: readonly string[] = [
  '/api/library/',
  '/api/requests/',
  '/api/admin/',
  '/api/dashboard/',
  '/api/auth/users/',
  '/api/chat/messages/',
  '/api/cli/',          // la self-update: CLI Bearer token (cliRelease.js)
];

// Pending users may use these too (their own account; /app, the install page).
const MEMBER_EXACT: ReadonlySet<string> = new Set(['/api/profile', '/api/app/latest']);
const MEMBER_PREFIXES: readonly string[] = ['/api/profile/'];

function matches(p: string, exact: ReadonlySet<string>, prefixes: readonly string[]): boolean {
  return exact.has(p) || prefixes.some(pre => p.startsWith(pre));
}

/**
 * Every path has exactly one policy (the last line is the default).
 *   public: no check. self: the route checks. member/approved: account level
 *   for an API route. page: an HTML route, needs a login.
 */
export function policyFor(p: unknown): Policy {
  // Express routes match case-insensitively (/API/playlists hits
  // /api/playlists), so classify the lowercased path; collapse "//" too.
  const pathname = String(p || '/').toLowerCase().replace(/\/{2,}/g, '/');
  if (matches(pathname, PUBLIC_EXACT, PUBLIC_PREFIXES)) return 'public';
  if (matches(pathname, SELF_EXACT, SELF_PREFIXES)) return 'self';
  if (matches(pathname, MEMBER_EXACT, MEMBER_PREFIXES)) return 'member';
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'approved';
  return 'page';
}

/**
 * @param secret   SESSION_SECRET (signs the dev-login cookie)
 * @param db       db module (isAvailable/query)
 * @param cacheMs  how long an account lookup is reused (status changes call
 *                 invalidate(), so this only bounds staleness elsewhere)
 * @param sessions central login: createOidcSessions() (resolveHeaders)
 * @param devLogin dev login (INSECURE_DEV_LOGIN): the `la_dev_login` cookie
 * Exactly one of sessions / devLogin.
 */
export function createUserAuth({ secret, db, cacheMs = 5000, sessions = null, devLogin = false }: {
  secret: string;
  db?: UserAuthDb | null;
  cacheMs?: number;
  sessions?: SessionLookup | null;
  devLogin?: boolean;
}): UserAuth {
  if (!secret) throw new Error('createUserAuth: secret is required');
  if (!!sessions === !!devLogin) throw new Error('createUserAuth: exactly one of sessions (central login) or devLogin');
  const mode: UserAuth['mode'] = sessions ? 'central' : 'dev';

  // users.id from a valid `la_dev_login` cookie (dev login only).
  function devUserIdFromHeaders(headers: IncomingHttpHeaders | null | undefined): string | null {
    const raw = parseCookie(headers && headers.cookie, DEV_COOKIE);
    if (!raw) return null;
    let token = raw;
    try { token = decodeURIComponent(raw); } catch {}
    const data = verifyDevToken(secret, token);
    return data ? String(data.id) : null;
  }

  // userId -> { account, at }
  const cache = new Map<string, { account: Account | null; at: number }>();

  /**
   * The account behind a user id: { id, status, name, emoji }, or null when
   * there is no such user. Throws when the database errors (callers fail
   * closed).
   */
  async function getAccount(userId: unknown): Promise<Account | null> {
    if (!userId) return null;
    const id = String(userId);
    if (!db || !db.isAvailable()) return { id, status: 'approved', name: null, emoji: null };
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < cacheMs) return hit.account;
    const r = await db.query<Pick<UserRow, 'id' | 'status' | 'display_name' | 'name' | 'username' | 'emoji'>>(
      'SELECT id, status, display_name, name, username, emoji FROM users WHERE id::text = $1',
      [id]
    );
    const row = r.rows[0];
    const account: Account | null = row ? {
      id,
      status: row.status || 'approved',
      name: row.display_name || row.name || row.username || null,
      emoji: row.emoji || null,
    } : null;
    cache.set(id, { account, at: Date.now() });
    if (cache.size > 10000) cache.delete(cache.keys().next().value!);
    return account;
  }

  function invalidate(userId?: unknown): void {
    if (userId === undefined) cache.clear();
    else cache.delete(String(userId));
  }

  /**
   * Who the headers (a request's, or a socket handshake's) belong to:
   * { userId, sessionId } or null. sessionId is the central-login session's
   * id hash (null with dev login). Says nothing about the account's status.
   * Central-login mode may re-check the session with the IdP here (at most
   * every few minutes; see oidcSessions.js). Throws on a storage error.
   */
  async function resolve(headers: IncomingHttpHeaders): Promise<Who | null> {
    if (mode === 'dev') {
      const userId = devUserIdFromHeaders(headers);
      return userId ? { userId, sessionId: null } : null;
    }
    const s = await sessions!.resolveHeaders(headers); // mode 'central': sessions is set
    return s ? { userId: String(s.userId), sessionId: s.idHash } : null;
  }

  /**
   * The Android app's `lam_` Bearer token -> { userId, sessionId } or null.
   * Central: the session store (re-checked when due, like a cookie session).
   * Dev: the signed dev token.
   */
  async function resolveMobile(token: string): Promise<Who | null> {
    if (mode === 'dev') {
      const data = verifyDevMobileToken(secret, token);
      return data ? { userId: String(data.id), sessionId: null } : null;
    }
    const s = await sessions!.resolveBearer(token); // mode 'central': sessions is set
    return s ? { userId: String(s.userId), sessionId: s.idHash } : null;
  }

  /**
   * resolve() for a request, once per request; a `lam_` Bearer (the Android
   * app) instead of the cookies when one is sent.
   */
  async function who(req: Request): Promise<Who | null> {
    if (req._listenWho === undefined) {
      const mobile = mobileBearer(req.headers);
      req._listenMobile = mobile !== null;
      req._listenWho = mobile !== null ? await resolveMobile(mobile) : await resolve(req.headers);
    }
    return req._listenWho as Who | null; // set just above, or by an earlier call
  }

  /** The caller's users.id (signed in; status not checked), or null. */
  async function userIdFor(req: Request): Promise<string | null> {
    const w = await who(req);
    return w ? w.userId : null;
  }

  /** { userId, account, sessionId } for a request, looked up once per request. */
  async function identify(req: Request): Promise<Identity> {
    if (req._listenAuth) return req._listenAuth;
    const w = await who(req);
    const userId = w ? w.userId : null;
    const account = userId ? await getAccount(userId) : null;
    // An account only comes from a userId, and a userId only from w: either all three are set or none.
    req._listenAuth = { userId: account ? userId : null, account, sessionId: account && w ? w.sessionId : null } as Identity;
    return req._listenAuth;
  }

  /** Express middleware: the caller's account must meet `level`, else 401/403 JSON. */
  function requireLevel(level: Level): RequestHandler {
    return (req, res, next) => {
      identify(req).then(({ account }) => {
        if (meetsLevel(account, level)) return next();
        const { status, body } = refusal(account, { mobile: !!req._listenMobile });
        res.status(status).json(body);
      }).catch((err) => {
        console.error('Account lookup failed:', err.message);
        res.status(503).json({ error: 'Could not check your account, try again' });
      });
    };
  }

  return {
    mode,
    resolve,
    userIdFor,
    getAccount,
    invalidate,
    identify,
    requireLevel,
  };
}

/** What createUserAuth() returns. */
export interface UserAuth {
  /** the sign-in fixed at boot */
  mode: 'central' | 'dev';
  resolve(headers: IncomingHttpHeaders): Promise<Who | null>;
  userIdFor(req: Request): Promise<string | null>;
  getAccount(userId: unknown): Promise<Account | null>;
  invalidate(userId?: unknown): void;
  identify(req: Request): Promise<Identity>;
  requireLevel(level: Level): RequestHandler;
}
