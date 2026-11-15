/**
 * The app's own HTTP routes, two routers because of where index.js mounts them:
 *
 *   createInfoRouter   GET /health, /api/version, /api/changelog, /changelog,
 *                      /api/qr/:lobbyId. Mounted BEFORE the library router,
 *                      whose router.use(apiLimiter) counts every request that
 *                      reaches it, so these stay outside the general limiter.
 *   createPageRouter   /admin and /lobby/... redirects, the SPA views,
 *                      GET /api/app/latest, the /dashboard shell and "/".
 *                      Mounted after the library router.
 *
 * Pages are the data-free SPA shell; the auth guard (authRoutes.js) decides
 * who reaches them.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const QRCode = require('qrcode');
const pkg = require('../package.json');
const { getVersionInfo } = require('./shared/build-info.ts');

// Event-loop delay (main thread busy) for /health, over the last minute.
// (The histogram includes its own sampling interval; /health subtracts it.)
const LOOP_DELAY_RESOLUTION_MS = 20;

/**
 * @param {object} deps
 * @param {{ isAvailable: () => boolean }} deps.db
 * @param {{ availableCached: () => Promise<boolean> }} deps.ytdlp
 * @param {string} deps.frontendPath - the frontend folder (index.html, changelog.html)
 * @returns {import('express').Router}
 */
function createInfoRouter({ db, ytdlp, frontendPath }) {
  const router = express.Router();

  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  loopDelay.enable();
  setInterval(() => loopDelay.reset(), 60 * 1000).unref();

  // How long one fs.stat waits: it runs on the libuv threadpool (shared with
  // file reads/writes, dns.lookup, crypto, zlib), so a slow answer means that
  // pool or the disk is saturated, not the main thread. Capped so /health
  // itself never hangs on it.
  function fsProbeMs(cap = 2000) {
    const t = process.hrtime.bigint();
    return Promise.race([
      fs.promises.stat(frontendPath).catch(() => null),
      new Promise((resolve) => setTimeout(resolve, cap).unref()),
    ]).then(() => Math.round(Number(process.hrtime.bigint() - t) / 1e5) / 10);
  }

  // Health check endpoint (Docker healthcheck every 30s). Must stay cheap: no
  // child processes, no database round trip.
  router.get('/health', async (req, res) => {
    // yt-dlp is only used for YouTube search / playlist listing now (no audio).
    // Cached: spawning it per request made this probe slow under load.
    const ytdlpAvailable = await ytdlp.availableCached();
    const ms = (ns) => Math.max(0, Math.round(ns / 1e5 - LOOP_DELAY_RESOLUTION_MS * 10) / 10);
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      ytdlp: ytdlpAvailable ? 'available' : 'unavailable',
      database: db.isAvailable() ? 'connected' : 'unavailable',
      library: db.isAvailable() ? 'enabled' : 'disabled',
      diag: {
        eventLoopDelayMs: { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) },
        fsProbeMs: await fsProbeMs(),
      },
    });
  });

  // Version endpoint
  router.get('/api/version', (req, res) => {
    res.json(getVersionInfo({ pkg }));
  });

  // Changelog endpoint - serves CHANGELOG.md as JSON
  router.get('/api/changelog', (req, res) => {
    // In Docker: /app/CHANGELOG.md, locally: ../../CHANGELOG.md from backend/src/
    const changelogPath = [
      path.join(__dirname, '..', 'CHANGELOG.md'),
      path.join(__dirname, '..', '..', 'CHANGELOG.md')
    ].find(p => fs.existsSync(p));
    try {
      const content = fs.readFileSync(changelogPath, 'utf8');
      res.json({ changelog: content });
    } catch {
      res.status(404).json({ error: 'Changelog not found' });
    }
  });

  // Changelog page
  router.get('/changelog', (req, res) => {
    res.sendFile(path.join(frontendPath, 'changelog.html'));
  });

  // Generate QR code for a playlist link. It only encodes the URL (the id comes
  // from the caller), so it reveals nothing about whether the playlist exists.
  router.get('/api/qr/:lobbyId', async (req, res) => {
    const lobbyId = req.params.lobbyId;
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(lobbyId)) return res.status(400).json({ error: 'Invalid id' });
    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/playlist/${lobbyId}`;

    try {
      const buffer = await QRCode.toBuffer(url, {
        width: 256,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
      res.type('png').send(buffer);
    } catch (err) {
      console.error('QR code generation error:', err.message);
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  });

  return router;
}

/**
 * @param {object} deps
 * @param {string} deps.frontendPath
 * @param {import('express').RequestHandler} deps.apiLimiter - rateLimits.apiLimiter
 * @param {{ isEnabled: () => boolean }} deps.adminAuth
 * @param {{ latest: () => Promise<object> }} deps.appRelease - appRelease.createAppRelease()
 * @returns {import('express').Router}
 */
function createPageRouter({ frontendPath, apiLimiter, adminAuth, appRelease }) {
  const router = express.Router();

  // The admin page moved into /dashboard. The query is dropped on purpose (the old
  // ?next= has no meaning any more).
  router.get('/admin', apiLimiter, (req, res) => res.redirect(301, '/dashboard'));

  // Old lobby URLs moved to /playlist/... (the client does the same for in-app
  // navigation, see legacyRedirect in frontend/router.js).
  router.get(['/lobby/:id', '/lobby/:id/library'], (req, res) => {
    const qs = req.originalUrl.indexOf('?');
    const rest = req.path.endsWith('/library') ? '/library' : '';
    res.redirect(301, `/playlist/${encodeURIComponent(req.params.id)}${rest}${qs >= 0 ? req.originalUrl.slice(qs) : ''}`);
  });

  // SPA views (auth guard applied above; the client routes them, see frontend/router.js)
  router.get(['/playlist/:id', '/playlist/:id/library', '/library', '/radio', '/artists', '/artist/:key', '/search', '/profile', '/social', '/app'], (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  // The latest Android release for the /app page. Always 200: when GitHub cannot
  // be reached the page still has its link to the releases page.
  router.get('/api/app/latest', apiLimiter, async (req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    res.json(await appRelease.latest());
  });

  // Dashboard page: the SPA shell, which holds no data. It asks /api/admin/status
  // and shows its login form until the la_admin cookie is set; everything it then
  // shows comes from APIs behind adminAuth.requireAdmin. 404 without ADMIN_PASSWORD.
  router.get('/dashboard', apiLimiter, (req, res) => {
    if (!adminAuth.isEnabled()) return res.status(404).type('text/plain').send('Admin is disabled (ADMIN_PASSWORD not set)');
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  // Serve index for root
  router.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  return router;
}

module.exports = { createInfoRouter, createPageRouter };
