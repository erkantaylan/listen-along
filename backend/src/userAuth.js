/**
 * Who is making a request, and what they may reach. The one place that turns
 * a request (or a socket handshake's headers) into a user id: resolve(),
 * userIdFor(), identify().
 *
 * Two modes, fixed at boot:
 *
 * - Legacy (no central login configured): identity is the HMAC-signed
 *   `listen_auth` cookie set after an OAuth login (Google / GitHub, see
 *   index.js): `<base64url {id, t}>.<sig>`. `id` is users.id, `t` the login
 *   time. The cookie lives 30 days and so does the token: an older token is
 *   refused even if a client kept the cookie.
 * - Central login (`sessions` given, OIDC_ISSUER + OIDC_CLIENT_ID set):
 *   identity is the opaque `la_session` cookie, looked up server-side and
 *   re-checked with the IdP (oidcSessions.js). The old `listen_auth` cookie is
 *   NOT a login in this mode: userIdFromHeaders() always answers null and
 *   nothing reads it (the OIDC callback only clears it; it plays no part in
 *   linking accounts).
 *
 * Account status (users.status) decides how far a logged-in user gets:
 *
 *   approved          everything (playlists, queue, library, streaming, ...)
 *   pending (or any   the global chat / people panel, their own profile and
 *   unknown status)   /api/auth/me. Nothing else.
 *   denied, rejected  nothing but /api/auth/me and logging out. Sockets are
 *                     refused at the handshake.
 *
 * Without a database there is no users table: a valid cookie counts as an
 * approved account (same as social.js).
 *
 * Levels used by requireLevel() / policyFor():
 *   'login'    a valid cookie naming an existing account (any status)
 *   'member'   ... that is not denied / rejected (approved or pending)
 *   'approved' ... whose status is 'approved'
 */

const crypto = require('crypto');

const COOKIE_NAME = 'listen_auth';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const BLOCKED_STATUSES = new Set(['denied', 'rejected']);

function parseCookie(header, name) {
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function isBlocked(status) {
  return BLOCKED_STATUSES.has(status);
}

function meetsLevel(account, level) {
  if (!account) return false;
  if (level === 'login') return true;
  if (level === 'member') return !isBlocked(account.status);
  if (level === 'approved') return account.status === 'approved';
  return false;
}

/** HTTP status + JSON body for an account that does not meet `level`. */
function refusal(account) {
  if (!account) return { status: 401, body: { error: 'Authentication required', code: 'AUTH_REQUIRED' } };
  if (isBlocked(account.status)) return { status: 403, body: { error: 'Access denied', code: 'ACCOUNT_DENIED' } };
  return { status: 403, body: { error: 'Your account is pending approval', code: 'ACCOUNT_PENDING' } };
}

// --- Route policy --------------------------------------------------------
// Deny by default: every path not listed here needs an approved account
// (/api/...) or a login (pages). Listed paths are either public or
// authenticate themselves with per-route middleware (CLI Bearer token, admin
// cookie, or "token or admin or approved user").

const PUBLIC_EXACT = new Set([
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
  // OAuth round trips. The /link routes check the login themselves.
  // 404 while central login is configured.
  '/auth/google',
  '/auth/google/callback',
  '/auth/github',
  '/auth/github/callback',
  '/auth/google/link',
  '/auth/google/link/callback',
  '/auth/github/link',
  '/auth/github/link/callback',
]);

const PUBLIC_PREFIXES = [
  '/lobby/',                // 301 to /playlist/..., which is guarded
];

// Routes with their own middleware (see index.js / libraryRoutes.js).
const SELF_EXACT = new Set(['/api/me', '/api/library', '/api/requests', '/dashboard', '/api/auth/users']);
const SELF_PREFIXES = [
  '/api/library/',
  '/api/requests/',
  '/api/admin/',
  '/api/dashboard/',
  '/api/auth/users/',
  '/api/chat/messages/',
  '/api/cli/',          // la self-update: CLI Bearer token (cliRelease.js)
];

// Pending users may use these too (their own account; /app, the install page).
const MEMBER_EXACT = new Set(['/api/profile', '/api/app/latest']);
const MEMBER_PREFIXES = ['/api/profile/'];

function matches(p, exact, prefixes) {
  return exact.has(p) || prefixes.some(pre => p.startsWith(pre));
}

/**
 * @returns {'public'|'self'|'member'|'approved'|'page'}
 *   public: no check. self: the route checks. member/approved: account level
 *   for an API route. page: an HTML route, needs a login.
 */
function policyFor(p) {
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
 * @param secret  HMAC key (SESSION_SECRET)
 * @param db      db module (isAvailable/query)
 * @param cacheMs how long an account lookup is reused (status changes call
 *                invalidate(), so this only bounds staleness elsewhere)
 * @param sessions central-login mode: createOidcSessions() (resolveHeaders);
 *                omitted = legacy mode
 */
function createUserAuth({ secret, db, cacheMs = 5000, sessions = null }) {
  if (!secret) throw new Error('createUserAuth: secret is required');
  const centralMode = !!sessions;

  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  function createToken(userId, t = Date.now()) {
    const payload = Buffer.from(JSON.stringify({ id: userId, t })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  /** @returns {{id, t}|null} */
  function verifyToken(token, now = Date.now()) {
    if (!token || typeof token !== 'string' || token.length > 2048) return null;
    const idx = token.indexOf('.');
    if (idx <= 0) return null;
    const payload = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const expected = sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
    if (!data || (typeof data.id !== 'string' && typeof data.id !== 'number') || data.id === '') return null;
    if (typeof data.t !== 'number' || !Number.isFinite(data.t)) return null;
    if (data.t > now + CLOCK_SKEW_MS || now - data.t > MAX_AGE_MS) return null;
    return data;
  }

  /** users.id from a valid legacy `listen_auth` cookie. Always null in central-login mode. */
  function userIdFromHeaders(headers) {
    if (centralMode) return null;
    return legacyUserIdFromHeaders(headers);
  }

  // The legacy cookie's users.id (legacy mode only: resolve() and
  // userIdFromHeaders() never call this in central-login mode).
  function legacyUserIdFromHeaders(headers) {
    const raw = parseCookie(headers && headers.cookie, COOKIE_NAME);
    if (!raw) return null;
    let token = raw;
    try { token = decodeURIComponent(raw); } catch {}
    const data = verifyToken(token);
    return data ? String(data.id) : null;
  }

  // userId -> { account, at }
  const cache = new Map();

  /**
   * The account behind a user id: { id, status, name, emoji }, or null when
   * there is no such user. Throws when the database errors (callers fail
   * closed).
   */
  async function getAccount(userId) {
    if (!userId) return null;
    const id = String(userId);
    if (!db || !db.isAvailable()) return { id, status: 'approved', name: null, emoji: null };
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < cacheMs) return hit.account;
    const r = await db.query(
      'SELECT id, status, display_name, name, username, emoji FROM users WHERE id::text = $1',
      [id]
    );
    const row = r.rows[0];
    const account = row ? {
      id,
      status: row.status || 'approved',
      name: row.display_name || row.name || row.username || null,
      emoji: row.emoji || null,
    } : null;
    cache.set(id, { account, at: Date.now() });
    if (cache.size > 10000) cache.delete(cache.keys().next().value);
    return account;
  }

  function invalidate(userId) {
    if (userId === undefined) cache.clear();
    else cache.delete(String(userId));
  }

  /**
   * Who the headers (a request's, or a socket handshake's) belong to:
   * { userId, sessionId } or null. sessionId is the central-login session's
   * id hash (null in legacy mode). Says nothing about the account's status.
   * Central-login mode may re-check the session with the IdP here (at most
   * every few minutes; see oidcSessions.js). Throws on a storage error.
   */
  async function resolve(headers) {
    if (!centralMode) {
      const userId = legacyUserIdFromHeaders(headers);
      return userId ? { userId, sessionId: null } : null;
    }
    const s = await sessions.resolveHeaders(headers);
    return s ? { userId: String(s.userId), sessionId: s.idHash } : null;
  }

  /** resolve() for a request, once per request. */
  async function who(req) {
    if (req._listenWho === undefined) req._listenWho = await resolve(req.headers);
    return req._listenWho;
  }

  /** The caller's users.id (signed in; status not checked), or null. */
  async function userIdFor(req) {
    const w = await who(req);
    return w ? w.userId : null;
  }

  /** { userId, account, sessionId } for a request, looked up once per request. */
  async function identify(req) {
    if (req._listenAuth) return req._listenAuth;
    const w = await who(req);
    const userId = w ? w.userId : null;
    const account = userId ? await getAccount(userId) : null;
    req._listenAuth = { userId: account ? userId : null, account, sessionId: account && w ? w.sessionId : null };
    return req._listenAuth;
  }

  /** Express middleware: the caller's account must meet `level`, else 401/403 JSON. */
  function requireLevel(level) {
    return (req, res, next) => {
      identify(req).then(({ account }) => {
        if (meetsLevel(account, level)) return next();
        const { status, body } = refusal(account);
        res.status(status).json(body);
      }).catch((err) => {
        console.error('Account lookup failed:', err.message);
        res.status(503).json({ error: 'Could not check your account, try again' });
      });
    };
  }

  return {
    centralMode,
    createToken,
    verifyToken,
    userIdFromHeaders,
    resolve,
    userIdFor,
    getAccount,
    invalidate,
    identify,
    requireLevel,
  };
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_MS,
  createUserAuth,
  parseCookie,
  isBlocked,
  meetsLevel,
  refusal,
  policyFor,
};
