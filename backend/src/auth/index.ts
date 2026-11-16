// Sign-in and access: what the composition root (main.ts) and the other areas
// use of auth/. Which sign-in exists is fixed at boot: central login (OIDC) or,
// in development and tests only, the dev sign-in. See CENTRAL-LOGIN.md.
//
// main.ts builds, in this order: readDevLogin / readOidcConfig (boot stops on
// a bad configuration), createOidcClient + createSessionStore +
// createOidcSessions (central login only), createUserAuth, then
// createAuthRoutes (the guard, the legacy status checks, the sign-in routes
// with the Android app's mounted on them) and createTokenRouter.
export { readOidcConfig } from './oidcConfig.ts';
export type { Env, OidcConfig, OidcConfigOn, OidcConfigOff, ProviderMap } from './oidcConfig.ts';
export { readDevLogin, signDevToken, DEV_COOKIE } from './devLogin.ts';
// The Android app's `lam_` Bearer of a request's headers (libraryRoutes: /api/me passes it on).
export { mobileBearer } from './mobileTokens.ts';
// The /dashboard cookie (la_admin): requireAdmin, isAdmin, the login's helpers.
export * as adminAuth from './adminAuth.ts';
// CLI tokens (la_...): requireToken, optionalToken, hasBearer, verifyToken and the store.
export * as tokens from './tokens.ts';
// The caller's own CLI tokens (/api/tokens).
export { createTokenRouter } from './tokenRoutes.ts';
export type { TokenRouterHooks } from './tokenRoutes.ts';
// Who a request or a socket handshake is, and the guard's policy per path.
export { createUserAuth, isBlocked, policyFor } from './userAuth.ts';
export type { UserAuth, SessionLookup, UserAuthDb } from './userAuth.ts';
// Central login: the OIDC client, the server-side sessions (cookie and app Bearer).
export { createOidcClient } from './oidc.ts';
export type { OidcClient } from './oidc.ts';
export { createSessionStore, createOidcSessions } from './oidcSessions.ts';
export type { SessionStore, OidcSessions } from './oidcSessions.ts';
// The guard and the sign-in / sign-out routes.
export { createAuthRoutes } from './authRoutes.ts';
export type { AuthRoutes, AuthRoutesDeps, AuthIo } from './authRoutes.ts';
export type {
  Account, ApiUser, PublicToken, ApiTokenRow, Identity, Level, Policy, Who, CentralClaims, Session, UserSessionRow,
} from './types.ts';
