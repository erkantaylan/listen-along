/**
 * Sign-in over HTTP: the deny-by-default auth guard and the routes around
 * signing in and out. Which sign-in exists is fixed at boot (index.js reads
 * it): central login (OIDC; oidc.ts, oidcSessions.ts, oidcLink.ts) or the
 * dev sign-in (INSECURE_DEV_LOGIN, devLogin.ts). See CENTRAL-LOGIN.md.
 *
 * createAuthRoutes() returns three routers, mounted by index.js at different
 * places because mount order is semantics in Express:
 *
 *   guard          the old Google / GitHub addresses (404) and the auth
 *                  guard; right after the static files, before every route.
 *   statusRouter   POST /api/auth/register, GET /api/auth/status (legacy
 *                  status checks); mounted before index.js counts /api/auth
 *                  against apiLimiter, so outside it.
 *   router         /auth/oidc/login|callback (central login only),
 *                  /auth/dev/login (dev sign-in only), GET /api/auth/me,
 *                  POST /api/auth/logout, GET /login,
 *                  GET /api/auth/providers.
 */

import express from 'express';
import type { CookieOptions, Request, RequestHandler, Response, Router } from 'express';
import path from 'path';
import { policyFor, parseCookie } from './userAuth.ts';
import type { UserAuth } from './userAuth.ts';
import { createMobileAuthRouter } from './mobileAuth.ts';
import { FLOW_COOKIE_PATH as OIDC_FLOW_PATH, FLOW_MAX_AGE_MS as OIDC_FLOW_MAX_AGE_MS } from './oidc.ts';
import type { OidcClient } from './oidc.ts';
import { linkCentralIdentity } from './oidcLink.ts';
import type { LinkResult } from './oidcLink.ts';
import { signDevToken, DEV_COOKIE, MAX_AGE_MS as DEV_LOGIN_MAX_AGE_MS } from './devLogin.ts';
import type { SessionStore, OidcSessions } from './oidcSessions.ts';
import type { Env, OidcConfig, OidcConfigOn } from './oidcConfig.ts';
import type { LimiterOptions } from '../shared/rateLimits.ts';
import type { Settings } from '../shared/settings.ts';
import type { DbModule } from '../shared/db.ts';
import type { UserRow } from '../shared/types.ts';
import type { Policy } from './types.ts';

// The old Google / GitHub login cookie. It is no login any more; sign-in and
// logout only delete it from browsers that still carry one.
export const LEGACY_LOGIN_COOKIE = 'listen_auth';

// The playlist API (/api/playlists, /api/lobbies) also takes a CLI Bearer
// token instead of the cookie (see the guard below).
const PLAYLIST_API_RE = /^\/api\/(?:playlists|lobbies)(?:\/|$)/;

// Post-login destination (?next): only same-origin relative paths. (true: a
// string and safe; false says nothing about the type, and no caller reads it then.)
export function isSafeNextPath(next: unknown): next is string {
  return typeof next === 'string' && /^\/(?![\/\\])[^\\\s\x00-\x1f]*$/.test(next);
}

// Where to send someone who is not logged in: /login, remembering the page.
function loginRedirectUrl(req: Request): string {
  const next = req.originalUrl;
  return isSafeNextPath(next) && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login';
}

/** The Socket.IO server as sign-in uses it: cut a session's sockets. */
export interface AuthIo {
  in(room: string): { disconnectSockets(close?: boolean): void };
}

/** What createAuthRoutes() needs from the composition root (index.js). */
export interface AuthRoutesDeps {
  /** oidcConfig.readOidcConfig() */
  oidc: OidcConfig;
  /** devLogin.readDevLogin(): the dev sign-in is on */
  devLogin: boolean;
  /** signs the dev sign-in cookie (and keys the app sign-in's nonce) */
  sessionSecret: string;
  /** DATABASE_URL is set (no pool = sign-in fails closed) */
  dbExpected: boolean;
  /** NODE_ENV (Secure cookies), AUTH_RATE_LIMIT, the app sign-in's settings */
  env: Env;
  /** index.html for /login */
  frontendPath: string;
  db: Pick<DbModule, 'isAvailable' | 'query' | 'getClient'>;
  settings: Pick<Settings, 'registrationsOpen'>;
  userAuth: UserAuth;
  /** oidc.createOidcClient(), central login only */
  oidcClient: OidcClient | null;
  /** oidcSessions.createSessionStore(), central login only */
  sessionStore: SessionStore | null;
  /** oidcSessions.createOidcSessions(), central login only */
  oidcSessions: OidcSessions | null;
  tokens: { hasBearer(req: Request): boolean; requireToken: RequestHandler };
  apiLimiter: RequestHandler;
  /** rateLimits.make */
  makeLimiter: (limit: number, windowMs?: number, opts?: LimiterOptions) => RequestHandler;
  io: AuthIo;
  /** the Socket.IO room of one central-login session */
  sessionRoom: (idHash: string) => string;
}

/** What createAuthRoutes() returns: three routers, mounted at different places. */
export interface AuthRoutes {
  guard: Router;
  statusRouter: Router;
  router: Router;
}

/** No database at all: the central sub is the user id, approved. */
interface MemoryLink {
  outcome: 'ok';
  rule: 'e';
  created: true;
  user: { id: string; status: 'approved' };
}

export function createAuthRoutes({
  oidc: OIDC, devLogin: DEV_LOGIN, sessionSecret: SESSION_SECRET, dbExpected: DB_EXPECTED, env, frontendPath,
  db, settings, userAuth, oidcClient, sessionStore, oidcSessions, tokens, apiLimiter, makeLimiter, io, sessionRoom,
}: AuthRoutesDeps): AuthRoutes {
  // ==========================================
  // The guard
  // ==========================================
  const guard = express.Router();

  // Google / GitHub sign-in and account linking were removed (central login
  // replaced them): their old addresses answer 404, not a login redirect.
  guard.use(['/auth/google', '/auth/github'], (req, res) => res.status(404).json({ error: 'Not found' }));

  // Auth guard: deny by default. policyFor() (userAuth.ts) classifies the path:
  //   public    no check (health, login round trips, static pages, shared YouTube page)
  //   self      the route has its own middleware (CLI Bearer token, admin
  //             cookie, or token-or-admin-or-approved-user)
  //   member    API a pending user may use too (own profile)
  //   approved  every other /api/... route
  //   page      every other HTML route: a login is needed (the SPA then shows
  //             the pending / denied screen itself); otherwise -> /login?next=
  //
  // The playlist API (/api/playlists, /api/lobbies) also takes a CLI Bearer
  // token instead of the cookie: the token must be valid (its owner approved),
  // and the routes then act as the token's owner (requireViewer).
  const playlistApi = (req: Request) => PLAYLIST_API_RE.test(String(req.path).toLowerCase().replace(/\/{2,}/g, '/'));
  // The playlist API's general limit (apiLimiter): once per request, cookie or
  // CLI token, counted before either is checked (token guessing is limited too).
  guard.use((req, res, next) => (playlistApi(req) ? apiLimiter(req, res, next) : next()));
  guard.use((req, res, next) => {
    if (tokens.hasBearer(req) && playlistApi(req)) return tokens.requireToken(req, res, next);
    const policy: Policy = policyFor(req.path);
    if (policy === 'public' || policy === 'self') return next();
    if (policy === 'page') {
      return userAuth.identify(req).then(({ account }) => {
        if (account) return next();
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
        }
        res.redirect(loginRedirectUrl(req));
      }).catch((err) => {
        console.error('Account lookup failed:', err.message);
        res.status(503).send('Could not check your login, try again');
      });
    }
    // Every other policy is an account level ('member' | 'approved'): a new
    // Policy that is not a Level does not compile here.
    return userAuth.requireLevel(policy)(req, res, next);
  });

  // ==========================================
  // Legacy status checks
  // ==========================================
  const statusRouter = express.Router();

  // Legacy registration / approval check from the localStorage-id era. The
  // caller is now always the logged-in account (or nobody): both answer that
  // account's status and ignore any userId/username in the request,
  // so nobody can create users or read another user's status.
  async function sendOwnStatus(req: Request, res: Response) {
    try {
      const { userId, account } = await userAuth.identify(req);
      res.json({ status: account ? account.status : 'unregistered', userId });
    } catch (err) {
      console.error('Auth status error:', (err as Error).message);
      res.status(500).json({ error: 'Failed to check status' });
    }
  }
  statusRouter.post('/api/auth/register', sendOwnStatus);
  statusRouter.get('/api/auth/status', sendOwnStatus);

  const router = express.Router();

  // ==========================================
  // Central login (OIDC): oidc.ts, oidcSessions.ts, oidcLink.ts
  // ==========================================
  // Only while OIDC_ISSUER + OIDC_CLIENT_ID are set (always in production).

  const secureCookies = env.NODE_ENV === 'production';
  // Where a failed or refused sign-in lands: the login page, with a code its
  // script turns into a sentence (never anything from the IdP or the request).
  const loginError = (code: string) => `/login?error=${code}`;
  // Central-login cookies: __Host-la_session / __Host-la_oidc_flow when Secure
  // (production), la_session / la_oidc_flow on plain http (oidcConfig.ts).
  const centralCookie = (extra: CookieOptions = {}): CookieOptions => ({ httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/', ...extra });

  if (OIDC.enabled) {
    // Sign-in round trips per client address (the project's limiter, rateLimits.js).
    const authLimit = Number.parseInt(env.AUTH_RATE_LIMIT as string, 10); // undefined -> NaN, as before
    const oidcLimiter = makeLimiter(Number.isFinite(authLimit) && authLimit > 0 ? authLimit : 30, 60 * 1000, { message: 'Too many sign-in attempts, try again in a minute' });

    // A claim the IdP should send (scope `upstream`) but does not: the IdP's
    // mapping is missing, so existing accounts cannot be matched by rule b.
    let missingUpstream = 0;

    // Start: state, nonce and PKCE verifier go into the encrypted flow cookie;
    // ?next must be a same-origin path, else home.
    router.get('/auth/oidc/login', oidcLimiter, async (req, res) => {
      const next = isSafeNextPath(req.query.next) ? req.query.next : '/';
      try {
        const { url, flowCookie } = await oidcClient!.startLogin({ next }); // central login: set
        res.cookie(OIDC.flowCookie, flowCookie, centralCookie({ maxAge: OIDC_FLOW_MAX_AGE_MS, path: OIDC_FLOW_PATH }));
        res.set('Cache-Control', 'no-store');
        res.redirect(url);
      } catch (err) {
        console.error(`[oidc] could not start a sign-in: ${(err as Error).message}`);
        res.redirect(loginError('signin_unavailable'));
      }
    });

    router.get('/auth/oidc/callback', oidcLimiter, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const flow = oidcClient!.openFlow(parseCookie(req.headers.cookie, OIDC.flowCookie));
      // The flow cookie is single-use, whatever happens next.
      res.clearCookie(OIDC.flowCookie, centralCookie({ path: OIDC_FLOW_PATH }));
      // An old Google / GitHub login cookie is no login and plays no part in
      // linking: it is just cleared.
      if (parseCookie(req.headers.cookie, LEGACY_LOGIN_COOKIE)) res.clearCookie(LEGACY_LOGIN_COOKIE, { path: '/' });

      const qs = req.originalUrl.indexOf('?');
      let result;
      try {
        result = await oidcClient!.finishLogin(qs >= 0 ? req.originalUrl.slice(qs + 1) : '', flow);
      } catch (caught) {
        const err = caught as { kind?: string; message?: string };
        console.warn(`[oidc] sign-in rejected (${err.kind || 'error'}): ${err.message}`);
        return res.redirect(loginError(err.kind === 'unavailable' ? 'signin_unavailable' : 'signin_failed'));
      }
      const { claims } = result;
      const short = (x: unknown) => `${String(x).slice(0, 8)}…`;

      // Database configured but not there: refuse, rather than inventing an
      // in-memory account (that is only for the no-database dev mode).
      if (DB_EXPECTED && !db.isAvailable()) {
        console.error('central-login: REFUSED sign-in: DATABASE_URL is set but the database is unavailable');
        return res.redirect(loginError('signin_unavailable'));
      }

      let upstreamNote = Array.isArray(claims.upstream_identities) ? String(claims.upstream_identities.length) : 'none';
      if (OIDC.upstreamExpected && !Object.prototype.hasOwnProperty.call(claims, 'upstream_identities')) {
        missingUpstream++;
        upstreamNote = `MISSING(#${missingUpstream})`;
        if (missingUpstream === 1) {
          console.warn('central-login: WARNING the id_token has no upstream_identities although OIDC_SCOPES asks for "upstream": the IdP mapping is missing, so existing accounts cannot be found by their Google / GitHub account (rule b). Keep registrations closed until this is fixed.');
        }
      }

      let linked: LinkResult | MemoryLink;
      try {
        if (db.isAvailable()) {
          linked = await linkCentralIdentity({
            db, claims, providerMap: OIDC.providerMap,
            registrationsOpen: () => settings.registrationsOpen(),
          });
        } else if (await settings.registrationsOpen()) {
          // No database at all: no users table; the central sub is the user id
          // (as a signed cookie's id was), and every account counts as approved.
          linked = { outcome: 'ok', rule: 'e', created: true, user: { id: claims.sub, status: 'approved' } };
        } else {
          linked = { outcome: 'refused', rule: 'e', reason: 'registrations_closed' };
        }
      } catch (err) {
        console.error(`central-login: linking failed sub=${short(claims.sub)}: ${(err as Error).message}`);
        return res.redirect(loginError('signin_failed'));
      }
      // One greppable line per sign-in: which rule, which user.
      if (linked.outcome !== 'ok') {
        console.log(`central-login: refused rule=${linked.rule || '-'} reason=${linked.reason} user=${linked.user ? linked.user.id : '-'} sub=${short(claims.sub)} upstream=${upstreamNote}`);
        return res.redirect(loginError(linked.reason));
      }
      const how = linked.created ? 'created' : linked.rule === 'a' ? 'signed-in' : 'linked';
      console.log(`central-login: link rule=${linked.rule} user=${linked.user.id} ${how} sub=${short(claims.sub)} upstream=${upstreamNote}`);

      try {
        // A session this browser already had (another account, or the same one)
        // is replaced, not left behind on the server.
        const previous = oidcSessions!.idHashFromHeaders(req.headers);
        if (previous) {
          await sessionStore!.remove(previous);
          io.in(sessionRoom(previous)).disconnectSockets(true);
        }
        const roles = Array.isArray(claims.roles) ? claims.roles.filter((r) => typeof r === 'string') : [];
        if (!result.refreshToken) console.warn('[oidc] the IdP sent no refresh token (offline_access not granted?): this session cannot be re-checked and ends after OIDC_MAX_UNVERIFIED_SECONDS');
        const s = await sessionStore!.create({
          userId: linked.user.id, sub: claims.sub, refreshToken: result.refreshToken, idToken: result.idToken, roles,
        });
        userAuth.invalidate(String(linked.user.id));
        res.cookie(OIDC.sessionCookie, s.rawId, centralCookie({ maxAge: s.maxAgeMs }));
        res.redirect(isSafeNextPath(flow!.next) ? flow!.next : '/'); // finishLogin refuses a missing flow
      } catch (err) {
        console.error(`[oidc] could not open a session: ${(err as Error).message}`);
        res.redirect(loginError('signin_failed'));
      }
    });
  }

  // ==========================================
  // Dev sign-in (devLogin.ts): INSECURE_DEV_LOGIN=1, development and tests only
  // ==========================================
  // The process refuses to start with it in production (readDevLogin in
  // index.js), so this route never exists there. /auth/dev/login?user=<users.id>&next=<path>
  // signs that user in; without ?user, a "Dev User" account (provider 'dev',
  // created once) or, without a database, the id 'dev'.
  if (DEV_LOGIN) {
    router.get('/auth/dev/login', async (req, res) => {
      const next = isSafeNextPath(req.query.next) ? req.query.next : '/';
      const asked = typeof req.query.user === 'string' ? req.query.user.trim().slice(0, 100) : '';
      let userId: string;
      try {
        if (!db.isAvailable()) {
          if (DB_EXPECTED) return res.status(503).type('text/plain').send('DATABASE_URL is set but the database is unavailable');
          userId = asked || 'dev';
        } else if (asked) {
          const r = await db.query<Pick<UserRow, 'id'>>('SELECT id FROM users WHERE id::text = $1', [asked]);
          if (!r.rows[0]) return res.status(404).type('text/plain').send('No user with that id');
          userId = r.rows[0].id;
        } else {
          const find = () => db.query<Pick<UserRow, 'id'>>(`SELECT id FROM users WHERE provider = 'dev' AND provider_id = 'dev'`);
          let r = await find();
          if (!r.rows[0]) {
            await db.query(
              `INSERT INTO users (provider, provider_id, name, status, created_at, updated_at)
               VALUES ('dev', 'dev', 'Dev User', 'approved', $1, $1) ON CONFLICT DO NOTHING`,
              [Date.now()]
            );
            r = await find();
          }
          userId = r.rows[0].id;
        }
      } catch (err) {
        console.error('[auth] dev sign-in failed:', (err as Error).message);
        return res.status(500).type('text/plain').send('Dev sign-in failed');
      }
      userAuth.invalidate(String(userId));
      res.cookie(DEV_COOKIE, signDevToken(SESSION_SECRET, String(userId)), {
        httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: DEV_LOGIN_MAX_AGE_MS,
      });
      res.set('Cache-Control', 'no-store');
      res.redirect(next);
    });
  }

  // Auth status endpoint// Auth status endpoint
  router.get('/api/auth/me', async (req, res) => {
    let userId: string | null;
    try { userId = await userAuth.userIdFor(req); } catch (err) {
      console.error('Auth check error:', (err as Error).message);
      return res.json({ authenticated: false });
    }
    if (!userId || !db.isAvailable()) {
      return res.json({ authenticated: false });
    }
    try {
      const result = await db.query<Pick<UserRow, 'id' | 'provider' | 'email' | 'name' | 'display_name' | 'emoji' | 'avatar_url' | 'status'>>('SELECT id, provider, email, name, display_name, emoji, avatar_url, status FROM users WHERE id::text = $1', [userId]);
      if (result.rows.length === 0) {
        return res.json({ authenticated: false });
      }
      const user = result.rows[0];
      res.json({
        authenticated: true,
        user: {
          id: user.id,
          provider: user.provider,
          email: user.email,
          name: user.display_name || user.name,
          displayName: user.display_name,
          emoji: user.emoji,
          avatarUrl: user.avatar_url,
          status: user.status
        }
      });
    } catch (err) {
      console.error('Auth check error:', (err as Error).message);
      res.json({ authenticated: false });
    }
  });

  // Logout endpoint. Central login: the server-side session goes first (its
  // sockets too), then the answer names the IdP's end-session URL (with
  // id_token_hint and the registered post-logout redirect "/") for the browser
  // to visit; without one the page just reloads. Dev sign-in: the cookie goes.
  router.post('/api/auth/logout', async (req, res) => {
    res.clearCookie(LEGACY_LOGIN_COOKIE, { path: '/' });
    if (DEV_LOGIN) {
      res.clearCookie(DEV_COOKIE, { path: '/' });
      return res.json({ success: true });
    }
    // Not the dev sign-in: central login, so OIDC is on and its client, store and sessions are set.
    res.clearCookie((OIDC as OidcConfigOn).sessionCookie, centralCookie());
    let idToken: string | null = null;
    try {
      const idHash = oidcSessions!.idHashFromHeaders(req.headers);
      if (idHash) {
        const s = await oidcSessions!.check(idHash, { recheckIfDue: false });
        if (s) idToken = s.idToken;
        await sessionStore!.remove(idHash);
        io.in(sessionRoom(idHash)).disconnectSockets(true);
      }
    } catch (err) {
      console.error('[oidc] logout could not remove the session:', (err as Error).message);
      return res.status(503).json({ error: 'Could not sign out, try again' });
    }
    const redirect = idToken ? await oidcClient!.endSessionUrl(idToken) : null;
    res.json({ success: true, redirect: redirect || '/' });
  });

  // Login page (the SPA's login view). Someone already logged in goes on to
  // ?next (a same-origin path) or home. The sign-in round trips carry ?next
  // themselves (the central login in its flow cookie).
  router.get('/login', apiLimiter, async (req, res) => {
    let account = null;
    try { ({ account } = await userAuth.identify(req)); } catch {}
    if (account) {
      const next = typeof req.query.next === 'string' && isSafeNextPath(req.query.next) ? req.query.next : '/';
      return res.redirect(next);
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  // Which sign-in the login page offers (its one "Sign in" button): the central
  // login, or the dev sign-in (development and tests only). Older pages read
  // `google` / `github` too; missing is false to them.
  router.get('/api/auth/providers', (req, res) => {
    res.json({ central: OIDC.enabled, dev: DEV_LOGIN });
  });

  // The Android app's sign-in (mobileAuth.ts): /auth/mobile/start | exchange |
  // logout (public in policyFor) and GET /api/me for an app session (the CLI
  // token's /api/me in libraryRoutes.js passes it on with next('route')).
  router.use(createMobileAuthRouter({
    oidc: oidcClient, cfg: OIDC, store: sessionStore, settings, userAuth, db, dbExpected: DB_EXPECTED,
    devLogin: DEV_LOGIN, secret: SESSION_SECRET, env,
  }));

  return { guard, statusRouter, router };
}
