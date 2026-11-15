// The sign-in area's shapes. Type-only: import with `import type`.
//
// Rows are written from the SQL in auth/schema.ts with node-postgres' default
// parsing (BIGINT a string, TIMESTAMPTZ a Date, JSONB parsed); change them with
// the schema. The users row itself is shared (shared/types.ts).
import type { AccountStatus } from '../shared/types.ts';

/** An `api_tokens` row (CLI tokens; only the SHA-256 of a token is stored). */
export interface ApiTokenRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  /** the owner (users.id); null for a legacy token from before ownership */
  user_id: string | null;
}

/** A CLI token as the profile page and the dashboard see it (tokens.toPublic). */
export interface PublicToken {
  id: string;
  name: string;
  label: string;
  prefix: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  active: boolean;
  owner: { id: string; name: string | null } | null;
}

/**
 * The caller behind a valid CLI token (`req.apiUser`, tokens.verifyToken).
 * `name` is who uploads are credited to: the owner's display name, or a legacy
 * token's own name.
 */
export interface ApiUser {
  /** api_tokens.id */
  id: string;
  name: string;
  label: string;
  /** the owner's users.id; null for a legacy token */
  userId: string | null;
  user: { id: string; name: string } | null;
}

/** An account as access checks see it (userAuth.getAccount). */
export interface Account {
  /** users.id */
  id: string;
  /** users.status; a row without one counts as approved */
  status: AccountStatus;
  name: string | null;
  emoji: string | null;
}

/**
 * How far an account gets (userAuth.requireLevel):
 *   login     a valid sign-in naming an existing account (any status)
 *   member    ... that is not denied / rejected (approved or pending)
 *   approved  ... whose status is 'approved'
 */
export type Level = 'login' | 'member' | 'approved';

/**
 * The guard's class of a path (userAuth.policyFor), deny by default:
 *   public    no check
 *   self      the route checks itself (CLI token, admin cookie, token or account)
 *   member    an API a pending account may use too
 *   approved  every other /api/... route
 *   page      every other HTML route: a sign-in is needed
 * The guard (authRoutes.ts) handles each one; `member` and `approved` are Levels.
 */
export type Policy = 'public' | 'self' | Extract<Level, 'member' | 'approved'> | 'page';

/**
 * Who a request (a web session cookie, or the Android app's `lam_` Bearer) or a
 * socket handshake (cookie only) belongs to. Says nothing about the account's
 * status. `sessionId` is the central-login session's id hash (cookie or app
 * session alike); null with the dev sign-in, which has no server-side session.
 */
export interface Who {
  userId: string;
  sessionId: string | null;
}

/**
 * identify(): the request's account, or nobody. Admin (the la_admin cookie) and
 * CLI tokens (req.apiUser) are separate and never an Identity.
 */
export type Identity =
  | { userId: string; account: Account; sessionId: string | null }
  | { userId: null; account: null; sessionId: null };

/** Where the sign-in code logs (console; tests pass their own). */
export type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/**
 * A validated id_token's claims, as this app reads them. openid-client checked
 * the signature, issuer, audience, expiry and nonce; oidc.finishLogin then
 * checked `sub` (a string of 1-255 characters), `aud` (exactly the client) and
 * `azp` (absent or the client). Every other claim stays `unknown` and is
 * checked where it is read (centralName, centralEmail, parseUpstream, roles).
 */
export interface CentralClaims {
  readonly sub: string;
  readonly aud?: unknown;
  readonly azp?: unknown;
  readonly name?: unknown;
  readonly preferred_username?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
  /** authentik's `upstream` scope: [{ provider, id }] (parseUpstream) */
  readonly upstream_identities?: unknown;
  /** the `entitlements` scope; stored with the session, gates nothing */
  readonly roles?: unknown;
  readonly [claim: string]: unknown;
}

/**
 * A `user_sessions` row: a central-login session, a browser's (cookie) or the
 * Android app's (`lam_` Bearer). Only the SHA-256 of the raw id is stored; the
 * tokens are AES-256-GCM boxes (shared/secretBox.ts) bound to the row's hash.
 */
export interface UserSessionRow {
  id_hash: string;
  user_id: string;
  oidc_sub: string;
  refresh_token_enc: string | null;
  id_token_enc: string | null;
  /** JSONB: the `roles` claim's strings (stored for later; gates nothing) */
  roles: unknown;
  /** BIGINT epoch ms */
  created_at: string;
  last_checked_at: string;
  expires_at: string;
}

/** A session as the store hands it out (oidcSessions fromRow): tokens opened, times as numbers. */
export interface Session {
  idHash: string;
  userId: string;
  sub: string;
  refreshToken: string | null;
  idToken: string | null;
  /** a stored token cannot be opened (SESSION_SECRET changed): the session ends */
  tokensBroken: boolean;
  roles: unknown[];
  createdAt: number;
  lastCheckedAt: number;
  expiresAt: number;
}
