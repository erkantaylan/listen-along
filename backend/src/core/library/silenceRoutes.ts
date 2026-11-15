// HTTP for the silence measurements (silence.ts):
//
//   GET /api/stream/silence?q=<queue entry url>   approved accounts (the guard's
//       default). The song behind a queue entry, as /api/stream resolves it
//       (`library:<id>`, a YouTube URL, a legacy source url): { lead_silence_ms,
//       trail_silence_ms } (null = not measured yet). 404 NOT_IN_LIBRARY, 400
//       without q, 503 without a database. The web player asks when a song
//       starts (skip silence); the song views carry the same two fields.
//   GET /api/admin/library/silence   admin: how far the measuring is.
import express from 'express';
import type { RequestHandler, Router } from 'express';
import type { SilenceScanner } from './silence.ts';

export interface SilenceRouterDeps {
  db: { isAvailable(): boolean };
  /** library.resolveQueueUrl: a queue entry's url -> the library_songs row, or null. */
  resolveQueueUrl: (url: string) => Promise<{ lead_silence_ms?: number | null; trail_silence_ms?: number | null } | null>;
  apiLimiter: RequestHandler;
  requireAdmin: RequestHandler;
  scanner: SilenceScanner;
}

/** What GET /api/stream/silence answers. */
export interface SongSilence {
  lead_silence_ms: number | null;
  trail_silence_ms: number | null;
}

const msOrNull = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

export function silenceOf(row: { lead_silence_ms?: unknown; trail_silence_ms?: unknown }): SongSilence {
  return { lead_silence_ms: msOrNull(row.lead_silence_ms), trail_silence_ms: msOrNull(row.trail_silence_ms) };
}

export function createSilenceRouter({ db, resolveQueueUrl, apiLimiter, requireAdmin, scanner }: SilenceRouterDeps): Router {
  const router = express.Router();

  router.get('/api/stream/silence', apiLimiter, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q) { res.status(400).json({ error: 'Missing query parameter: q' }); return; }
    if (!db.isAvailable()) { res.status(503).json({ error: 'Library unavailable (no database)', code: 'NO_DATABASE' }); return; }
    try {
      const song = await resolveQueueUrl(q);
      if (!song) { res.status(404).json({ error: 'This song is not in the library yet', code: 'NOT_IN_LIBRARY' }); return; }
      // A replace resets the numbers: never cache them.
      res.set('Cache-Control', 'no-store');
      res.json(silenceOf(song));
    } catch (err) {
      console.error('Silence lookup failed:', (err as Error).message);
      res.status(500).json({ error: 'Silence lookup failed' });
    }
  });

  router.get('/api/admin/library/silence', requireAdmin, async (_req, res) => {
    res.json(await scanner.stats());
  });

  return router;
}
