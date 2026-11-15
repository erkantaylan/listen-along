// Sign-in and access: what the composition root (index.js) and the other areas
// use of auth/. Which sign-in exists is fixed at boot: central login (OIDC) or,
// in development and tests only, the dev sign-in. See CENTRAL-LOGIN.md.
export { readOidcConfig, OidcConfigError } from './oidcConfig.ts';
export type { Env, OidcConfig, OidcConfigOn, OidcConfigOff, ProviderMap } from './oidcConfig.ts';
export { readDevLogin, signDevToken, DEV_COOKIE, DevLoginError } from './devLogin.ts';
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
export type { Account, ApiUser, PublicToken, ApiTokenRow, Identity, Level, Policy, Who } from './types.ts';
