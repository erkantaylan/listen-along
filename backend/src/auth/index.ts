// Sign-in and access: what the composition root (index.js) and the other areas
// use of auth/. Which sign-in exists is fixed at boot: central login (OIDC) or,
// in development and tests only, the dev sign-in. See CENTRAL-LOGIN.md.
export { readOidcConfig, OidcConfigError } from './oidcConfig.ts';
export type { Env, OidcConfig, OidcConfigOn, OidcConfigOff, ProviderMap } from './oidcConfig.ts';
export { readDevLogin, signDevToken, DEV_COOKIE, DevLoginError } from './devLogin.ts';
export { mobileBearer } from './mobileTokens.ts';
// The /dashboard cookie (la_admin): requireAdmin, isAdmin, the login's helpers.
export * as adminAuth from './adminAuth.ts';
