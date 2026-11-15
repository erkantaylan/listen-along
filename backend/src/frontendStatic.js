/**
 * Static files of the web app, served at the site root from two folders:
 *
 *   <frontend>/dist   compiled TypeScript (frontend/src/**.ts -> dist/**.js + .js.map)
 *   <frontend>        everything else: index.html, CSS, vendor/, locales/,
 *                     icons, and the not yet converted .js modules
 *
 * dist/ is mounted FIRST, so a compiled module wins over a stale old file of
 * the same name (during the conversion a module should exist in only one of
 * them). A missing dist/ (a fresh checkout before `npm run build`) is not an
 * error: express.static falls through on ENOENT and the second mount answers.
 *
 * Build configuration in frontend/ (package.json, tsconfig.json, build info)
 * and the /dist/ folder itself are not site assets: they answer 404. Sources
 * under /src/ stay reachable so source maps resolve in dev tools.
 *
 * Both mounts are `index: false` so "/" goes through the auth guard; .js, .css,
 * .map and .ts are `no-cache` (revalidate every load, deploys take effect at once).
 */
const path = require('path');
const express = require('express');

const BUILD_CONFIG = new Set(['/package.json', '/tsconfig.json']);

/** True for a request path that must not be served from frontend/. */
function isBuildConfig(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return false; }
  // The same normalisation serve-static applies before joining with the root;
  // lower-cased for case-insensitive file systems.
  p = path.posix.normalize('/' + p.replace(/\\/g, '/')).toLowerCase();
  return BUILD_CONFIG.has(p) || p.endsWith('.tsbuildinfo') || p === '/dist' || p.startsWith('/dist/');
}

function setHeaders(res, filePath) {
  if (/\.(js|css|map|ts)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  // A source for dev tools; the default type for .ts is video/mp2t.
  if (filePath.endsWith('.ts')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
}

/** Middleware list for `app.use(...)`: deny build config, then dist/, then frontend/. */
function frontendStatic(frontendPath) {
  const distPath = path.join(frontendPath, 'dist');
  return [
    (req, res, next) => (isBuildConfig(req.path) ? res.sendStatus(404) : next()),
    express.static(distPath, { index: false, setHeaders }),
    express.static(frontendPath, { index: false, setHeaders }),
  ];
}

module.exports = { frontendStatic, isBuildConfig };
