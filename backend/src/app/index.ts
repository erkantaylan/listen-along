// The app's own wiring, used by the composition root (main.ts) only: the
// Express app and HTTP server (http.ts, frontendStatic.ts), the Socket.IO server
// and its connection handler (sockets.ts), the cross-area reactions
// (reactions.ts), and the routes that belong to no single area: health /
// version / changelog / QR and the pages (appRoutes.ts), the caller's profile
// (profileRoutes.ts) and the dashboard's account, settings, stats and
// moderation APIs (adminRoutes.ts).
export { createHttpApp } from './http.ts';
export type { HttpApp } from './http.ts';
export { frontendStatic, isBuildConfig } from './frontendStatic.ts';
export { APP_ROOM, userRoom, sessionRoom, createSocketServer, socketOriginAllowed, attachSocketHandlers } from './sockets.ts';
export type { SocketHandlersDeps } from './sockets.ts';
export { createReactions } from './reactions.ts';
export type { ReactionsDeps } from './reactions.ts';
export { createInfoRouter, createPageRouter } from './appRoutes.ts';
export type { InfoRouterDeps, PageRouterDeps } from './appRoutes.ts';
export { createProfileRouter } from './profileRoutes.ts';
export type { ProfileRouterDeps } from './profileRoutes.ts';
export { createAdminRouter } from './adminRoutes.ts';
export type { AdminRouterDeps } from './adminRoutes.ts';
