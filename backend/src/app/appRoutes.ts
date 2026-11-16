/**
 * The app's own HTTP routes, two routers because of where main.ts mounts them:
 *
 *   createInfoRouter   GET /health, /api/version, /api/changelog, /changelog,
 *                      /api/qr/:playlistId. Mounted before the library router;
 *                      only the changelog routes (they read files) count
 *                      against the general limiter (apiLimiter).
 *   createPageRouter   /admin and /lobby/... redirects, the SPA views,
 *                      GET /api/app/latest, the /dashboard shell and "/".
 *                      Mounted after the library router.
 *
 * Pages are the data-free SPA shell; the auth guard (auth/authRoutes.ts) decides
 * who reaches them.
 */

import express from 'express';
import type { RequestHandler, Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import QRCode from 'qrcode';
import pkg from '../../package.json' with { type: 'json' };
import { getVersionInfo } from '../shared/build-info.ts';
import type { AppLatest } from '../features/app-release/index.ts';

// The backend's src/ folder: this file is src/app/appRoutes.ts.
const SRC_DIR = path.join(import.meta.dirname, '..');

// Event-loop delay (main thread busy) for /health, over the last minute.
// (The histogram includes its own sampling interval; /health subtracts it.)
const LOOP_DELAY_RESOLUTION_MS = 20;

export interface InfoRouterDeps {
  db: { isAvailable(): boolean };
  ytdlp: { availableCached(): Promise<boolean> };
  /** the frontend folder (index.html, changelog.html) */
  frontendPath: string;
  /** rateLimits.apiLimiter */
  apiLimiter: RequestHandler;
}

export function createInfoRouter({ db, ytdlp, frontendPath, apiLimiter }: InfoRouterDeps): Router {
  const router = express.Router();

  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  loopDelay.enable();
  setInterval(() => loopDelay.reset(), 60 * 1000).unref();

  // How long one fs.stat waits: it runs on the libuv threadpool (shared with
  // file reads/writes, dns.lookup, crypto, zlib), so a slow answer means that
  // pool or the disk is saturated, not the main thread. Capped so /health
  // itself never hangs on it.
  function fsProbeMs(cap = 2000): Promise<number> {
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
    const ms = (ns: number) => Math.max(0, Math.round(ns / 1e5 - LOOP_DELAY_RESOLUTION_MS * 10) / 10);
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
  router.get('/api/changelog', apiLimiter, (req, res) => {
    // In Docker: /app/CHANGELOG.md, locally: ../../CHANGELOG.md from backend/src/
    const changelogPath = [
      path.join(SRC_DIR, '..', 'CHANGELOG.md'),
      path.join(SRC_DIR, '..', '..', 'CHANGELOG.md')
    ].find(p => fs.existsSync(p));
    try {
      // Neither found: readFileSync(undefined) throws, answered as a 404 below.
      const content = fs.readFileSync(changelogPath!, 'utf8');
      res.json({ changelog: content });
    } catch {
      res.status(404).json({ error: 'Changelog not found' });
    }
  });

  // Changelog page
  router.get('/changelog', apiLimiter, (req, res) => {
    res.sendFile(path.join(frontendPath, 'changelog.html'));
  });

  // Generate QR code for a playlist link. It only encodes the URL (the id comes
  // from the caller), so it reveals nothing about whether the playlist exists.
  router.get('/api/qr/:playlistId', async (req, res) => {
    const playlistId = req.params.playlistId;
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(playlistId)) return res.status(400).json({ error: 'Invalid id' });
    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/playlist/${playlistId}`;

    try {
      const buffer = await QRCode.toBuffer(url, {
        width: 256,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
      res.type('png').send(buffer);
    } catch (err) {
      console.error('QR code generation error:', (err as Error).message);
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  });

  return router;
}

export interface PageRouterDeps {
  frontendPath: string;
  /** rateLimits.apiLimiter */
  apiLimiter: RequestHandler;
  adminAuth: { isEnabled(): boolean };
  /** features/app-release createAppRelease() */
  appRelease: { latest(): Promise<AppLatest> };
}

export function createPageRouter({ frontendPath, apiLimiter, adminAuth, appRelease }: PageRouterDeps): Router {
  const router = express.Router();

  // The admin page moved into /dashboard. The query is dropped on purpose (the old
  // ?next= has no meaning any more).
  router.get('/admin', apiLimiter, (req, res) => res.redirect(301, '/dashboard'));

  // Old /lobby/... URLs moved to /playlist/... (the client does the same for in-app
  // navigation, see legacyRedirect in frontend/src/router.ts).
  router.get(['/lobby/:id', '/lobby/:id/library'], apiLimiter, (req, res) => {
    const qs = req.originalUrl.indexOf('?');
    const rest = req.path.endsWith('/library') ? '/library' : '';
    res.redirect(301, `/playlist/${encodeURIComponent(req.params.id)}${rest}${qs >= 0 ? req.originalUrl.slice(qs) : ''}`);
  });

  // SPA views (auth guard applied above; the client routes them, see frontend/src/router.ts)
  router.get(['/playlist/:id', '/playlist/:id/library', '/library', '/radio', '/artists', '/artist/:key', '/search', '/profile', '/social', '/app'], apiLimiter, (req, res) => {
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
  router.get('/', apiLimiter, (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  return router;
}

