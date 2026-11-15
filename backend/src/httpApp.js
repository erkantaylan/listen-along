/**
 * The Express app and its HTTP server, with everything that runs before any
 * route, in this order: the client IP (clientIp.js), CORS, the JSON body
 * parser, one log line per dynamic request, and the static frontend files
 * (frontendStatic.js). index.js mounts the auth guard and the routes after.
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const clientIpSetup = require('./clientIp');
const { frontendStatic } = require('./frontendStatic');

// Requests the log skips (static assets).
const STATIC_ASSET_RE = /\.(?:js|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map)$/i;

// Sign-in round trips whose query stays out of the log: the web callback
// carries a one-time code, the app's start its state, nonce and PKCE
// challenge, the app's https callback (its fallback page) a code and state
// (mobileAuth.js). Matched case-insensitively, as Express routes.
const QUERY_HIDDEN_PATHS = new Set(['/auth/oidc/callback', '/auth/mobile/start', '/auth/mobile/callback']);
function loggedUrl(req) {
  const p = String(req.path || '').toLowerCase().replace(/\/{2,}/g, '/');
  if (!QUERY_HIDDEN_PATHS.has(p)) return req.originalUrl;
  return req.originalUrl.includes('?') ? `${req.path}?…` : req.path;
}

/**
 * @param {object} deps
 * @param {import('cors').CorsOptions} deps.corsOptions - shared with Socket.IO
 * @param {string} deps.frontendPath - the frontend folder (its dist/ is served first)
 * @returns {{ app: import('express').Express, server: import('http').Server, clientIpOf: (req: object) => string }}
 */
function createHttpApp({ corsOptions, frontendPath }) {
  const app = express();
  const server = http.createServer(app);

  // Behind Cloudflare -> Traefik: trust the private proxy hop and take the
  // visitor's IP from CF-Connecting-IP only when the request really came from
  // Cloudflare. Sets req.clientIp, which the rate limits key on. See clientIp.js.
  const clientIpOf = clientIpSetup.install(app);

  app.use(cors(corsOptions));
  app.use(express.json());

  // HTTP request logging — one concise line per dynamic request with status +
  // duration, a SLOW tag for anything over 5s, and a PENDING warning for requests
  // still running after 15s. The PENDING warning is the key diagnostic: a request
  // that hangs (yt-dlp/db/upstream stall) otherwise surfaces only as a proxy 504
  // with nothing in our own logs. Static assets are skipped to keep signal high.
  app.use((req, res, next) => {
    if (STATIC_ASSET_RE.test(req.path)) return next();
    const start = Date.now();
    let logged = false;
    const pending = setTimeout(() => {
      console.warn(`[http] PENDING ${req.method} ${loggedUrl(req)} still running after 15s`);
    }, 15000);
    const finish = (aborted) => {
      if (logged) return;
      logged = true;
      clearTimeout(pending);
      const ms = Date.now() - start;
      const status = aborted ? 'ABORTED' : res.statusCode;
      const slow = ms > 5000 ? ' SLOW' : '';
      const line = `[http] ${req.method} ${loggedUrl(req)} ${status} ${ms}ms${slow}`;
      if (aborted || res.statusCode >= 500 || ms > 5000) console.warn(line);
      else console.log(line);
    };
    res.on('finish', () => finish(false));
    res.on('close', () => { if (!res.writableEnded) finish(true); });
    next();
  });

  // Static assets (scripts, styles, icons, locales) are public: they hold no
  // data. `index: false` so "/" goes through the auth guard instead of
  // express.static answering it with index.html. Compiled TypeScript in
  // <frontend>/dist is served first, at the same URLs (frontendStatic.js).
  app.use(frontendStatic(frontendPath));

  return { app, server, clientIpOf };
}

module.exports = { createHttpApp };
