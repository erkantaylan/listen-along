// The latest Android release for the /app page (GET /api/app/latest, served by
// appRoutes.js createPageRouter, which gets the instance in its deps).
export { createAppRelease, RELEASES_PAGE } from './appRelease.ts';
export type { AppRelease, AppReleaseOptions, AppLatest, AppReleaseView } from './appRelease.ts';
