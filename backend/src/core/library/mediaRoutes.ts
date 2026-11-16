/**
 * Audio and covers for queue entries:
 *
 *   GET /api/stream?q=<queue entry url>[&dl=1]   the library song behind a
 *       queue entry (a YouTube URL, `library:<id>` or a legacy cache URL).
 *       The server never downloads: anything not in the library is a 404
 *       NOT_IN_LIBRARY.
 *   GET /api/covers/:id[?fallback=<url>]   a queue entry's cached cover, else
 *       a redirect to the fallback thumbnail on a known image host.
 */

import express from 'express';
import type { Request, RequestHandler, Response, Router } from 'express';
import path from 'node:path';
import type { LibrarySongRow } from '../../shared/types.ts';
import type { CoverInfo } from './covers.ts';
import type { SendSongFile } from './libraryRoutes.ts';

// Where a missing cover may send the browser instead: the image hosts queue
// entries' thumbnails come from (YouTube: library songs, search, yt-dlp; YouTube
// Music; Spotify track links), each one exactly, never a whole domain (other
// hosts under googleusercontent.com or youtube.com serve pages people write).
// The target is rebuilt from the fixed https origin + the path and query of the
// given URL, so nothing in the request decides where it points.
export function coverRedirectTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null; // ?fallback=a&fallback=b is an array
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const rest = `${u.pathname}${u.search}`.slice(1); // the pathname always starts with "/"
  switch (u.hostname) {
    case 'i.ytimg.com': return 'https://i.ytimg.com/' + rest;
    case 'img.youtube.com': return 'https://img.youtube.com/' + rest;
    case 'yt3.ggpht.com': return 'https://yt3.ggpht.com/' + rest;
    case 'lh3.googleusercontent.com': return 'https://lh3.googleusercontent.com/' + rest;
    case 'i.scdn.co': return 'https://i.scdn.co/' + rest;
    case 'mosaic.scdn.co': return 'https://mosaic.scdn.co/' + rest;
    case 'image-cdn-ak.spotifycdn.com': return 'https://image-cdn-ak.spotifycdn.com/' + rest;
    case 'image-cdn-fa.spotifycdn.com': return 'https://image-cdn-fa.spotifycdn.com/' + rest;
    default: return null;
  }
}
export const isAllowedCoverUrl = (value: unknown): boolean => coverRedirectTarget(value) !== null;

/** What the media routes need (main.ts passes the library's own modules). */
export interface MediaRouterDeps {
  db: { isAvailable(): boolean };
  library: { resolveQueueUrl(url: string): Promise<LibrarySongRow | null> };
  covers: { getCachedCover(id: string): CoverInfo | null; COVERS_DIR: string };
  /** rateLimits.apiLimiter */
  apiLimiter: RequestHandler;
  /** libraryRoutes.sendSongFile */
  sendSongFile: SendSongFile;
}

export function createMediaRouter({ db, library, covers, apiLimiter, sendSongFile }: MediaRouterDeps): Router {
  const router = express.Router();

  // Play audio for a queue entry. `q` is the queue entry's url: a YouTube URL
  // (looked up by youtube_id), `library:<id>`, or a legacy cache URL. The server
  // never downloads: anything not in the library is a 404 NOT_IN_LIBRARY.
  router.get('/api/stream', apiLimiter, async (req: Request, res: Response) => {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Missing query parameter: q' });
    }
    if (!db.isAvailable()) {
      return res.status(503).json({ error: 'Library unavailable (no database)', code: 'NO_DATABASE' });
    }
    // When dl is set, force the browser to save the file instead of playing it
    // inline. Used by the "Download playlist" feature.
    const forceDownload = req.query.dl === '1' || req.query.dl === 'true';
    try {
      const song = await library.resolveQueueUrl(String(q));
      if (!song) {
        return res.status(404).json({ error: 'This song is not in the library yet', code: 'NOT_IN_LIBRARY' });
      }
      sendSongFile(req, res, song, { download: forceDownload });
    } catch (err) {
      console.error('Stream error:', (err as Error).message);
      res.status(500).json({ error: 'Stream error' });
    }
  });

  // Get cached cover art for a song
  router.get('/api/covers/:id', apiLimiter, (req: Request<{ id: string }>, res: Response) => {
    const songId = req.params.id;
    const fallbackUrl = req.query.fallback;

    const cached = covers.getCachedCover(songId);
    if (cached) {
      // Validate cached path is within COVERS_DIR to prevent path traversal
      const resolvedPath = path.resolve(cached.path);
      const coversBase = path.resolve(covers.COVERS_DIR);
      if (!resolvedPath.startsWith(coversBase + path.sep) && resolvedPath !== coversBase) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
      return res.sendFile(resolvedPath);
    }

    // Not cached - redirect to the fallback thumbnail, but only on a known
    // image host (anything else would make this an open redirect).
    if (fallbackUrl) {
      const target = coverRedirectTarget(fallbackUrl);
      if (!target) return res.status(400).json({ error: 'Invalid fallback URL' });
      return res.redirect(target);
    }

    res.status(404).json({ error: 'Cover not found' });
  });

  return router;
}

