// Proves the frontend build end to end (tsc -> frontend/dist -> Docker image
// -> served at /build-probe.js; frontend-static.test.js checks it). Nothing
// imports it. Delete it, and its check in that test, once the first real
// module lives in frontend/src.
export const BUILD_PROBE: string = 'frontend/src compiled to frontend/dist';
