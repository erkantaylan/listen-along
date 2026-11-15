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

const express = require('express');
const path = require('path');

// Thumbnail hosts queue entries use: YouTube (library songs, search) and
// Spotify (track links).
const COVER_HOST_SUFFIXES = ['ytimg.com', 'youtube.com', 'ggpht.com', 'googleusercontent.com', 'scdn.co', 'spotifycdn.com'];
function isAllowedCoverUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return COVER_HOST_SUFFIXES.some(sfx => host === sfx || host.endsWith('.' + sfx));
}

/**
 * @param {object} deps
 * @param {{ isAvailable: () => boolean }} deps.db
 * @param {{ resolveQueueUrl: (url: string) => Promise<object|null> }} deps.library
 * @param {{ getCachedCover: (id: string) => ({ path: string, contentType: string }|null), COVERS_DIR: string }} deps.covers
 * @param {import('express').RequestHandler} deps.apiLimiter - rateLimits.apiLimiter
 * @param {(req: object, res: object, song: object, opts?: { download?: boolean }) => void} deps.sendSongFile - libraryRoutes.sendSongFile
 * @returns {import('express').Router}
 */
function createMediaRouter({ db, library, covers, apiLimiter, sendSongFile }) {
  const router = express.Router();

  // Play audio for a queue entry. `q` is the queue entry's url: a YouTube URL
  // (looked up by youtube_id), `library:<id>`, or a legacy cache URL. The server
  // never downloads: anything not in the library is a 404 NOT_IN_LIBRARY.
  router.get('/api/stream', apiLimiter, async (req, res) => {
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
      console.error('Stream error:', err.message);
      res.status(500).json({ error: 'Stream error' });
    }
  });

  // Get cached cover art for a song
  router.get('/api/covers/:id', (req, res) => {
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
      if (!isAllowedCoverUrl(fallbackUrl)) {
        return res.status(400).json({ error: 'Invalid fallback URL' });
      }
      return res.redirect(fallbackUrl);
    }

    res.status(404).json({ error: 'Cover not found' });
  });

  return router;
}

module.exports = { createMediaRouter, isAllowedCoverUrl };
