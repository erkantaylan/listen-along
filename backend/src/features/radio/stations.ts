/**
 * Radio stations: a station is "a list of songs from a rule". A rule is a SQL
 * condition on library_songs, and `all` is the first one (every song nobody has
 * marked broken). The server knows the songs; the order is the listener's own
 * (shuffled in the browser, frontend/radio-order.js).
 *
 * GET /api/stations/:id        { id, count, duration_sec }
 * GET /api/stations/:id/songs  the same + songs (lean: no reports or upload details; with the
 *                              album, which Radio's search matches)
 *
 * Paging /api/library for this would take three requests at 2,500 songs, could
 * skip or repeat songs when an upload lands in between, and has no "not broken"
 * filter. These routes are approved accounts only: the guard's default for
 * /api/... (policyFor in userAuth.js); CLI tokens do not get in.
 */
import express from 'express';
import type { Request, Response, Router } from 'express';
import dbModule from '../../shared/db.ts';
import { OPEN_REPORT_EXISTS_SQL } from '../../songReports.js';
import type { Db, LibrarySongRow } from '../../shared/types.ts';

// The live module object: tests replace its functions.
const db: Db = dbModule;

const RULES = new Map([
  ['all', `NOT ${OPEN_REPORT_EXISTS_SQL}`],
]);

/** The library columns a station song is made of. */
export type StationSongRow = Pick<LibrarySongRow, 'id' | 'youtube_id' | 'title' | 'artist' | 'duration_sec' | 'sha256'>;

/** A song in a station (and on an artist page): lean, no reports or upload details. */
export interface StationSong {
  id: string;
  youtube_id: string | null;
  title: string;
  artist: string;
  duration_sec: number | null;
  /** the first 16 hex digits of the file's sha256 (the audio url's ?v=) */
  file_version: string | null;
}

/** GET /api/stations/:id */
export interface StationSummary {
  id: string;
  count: number;
  duration_sec: number;
}

/** A station song: the lean row plus its album, which Radio's search matches too. */
export interface StationListSong extends StationSong {
  album: string | null;
}

/** GET /api/stations/:id/songs */
export interface StationSongs extends StationSummary {
  songs: StationListSong[];
}

export function toStationSong(row: StationSongRow): StationSong {
  return {
    id: row.id,
    youtube_id: row.youtube_id || null,
    title: row.title,
    artist: row.artist,
    duration_sec: row.duration_sec === null || row.duration_sec === undefined ? null : Number(row.duration_sec),
    file_version: row.sha256 ? String(row.sha256).slice(0, 16) : null,
  };
}

async function summary(id: string): Promise<StationSummary> {
  const r = await db.query<{ count: number; duration_sec: string }>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(duration_sec), 0)::bigint AS duration_sec FROM library_songs WHERE ${RULES.get(id)}`
  );
  return { id, count: r.rows[0].count, duration_sec: Number(r.rows[0].duration_sec) };
}

async function songs(id: string): Promise<StationSongs> {
  const r = await db.query<StationSongRow & { album: string | null }>(
    `SELECT id, youtube_id, title, artist, album, duration_sec, sha256 FROM library_songs WHERE ${RULES.get(id)} ORDER BY id`
  );
  const list = r.rows.map((row): StationListSong => ({ ...toStationSong(row), album: row.album || null }));
  return { id, count: list.length, duration_sec: list.reduce((sum, s) => sum + (s.duration_sec || 0), 0), songs: list };
}

export function createStationRouter(): Router {
  const router = express.Router();
  const route = (load: (id: string) => Promise<StationSummary>) => async (req: Request<{ id: string }>, res: Response) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'The music library needs a database' });
    if (!RULES.has(req.params.id)) return res.status(404).json({ error: 'Unknown station' });
    try {
      res.json(await load(req.params.id));
    } catch (err) {
      console.error('[stations] error:', (err as Error).message);
      res.status(500).json({ error: 'Failed to load the station' });
    }
  };
  router.get('/api/stations/:id', route(summary));
  router.get('/api/stations/:id/songs', route(songs));
  return router;
}
