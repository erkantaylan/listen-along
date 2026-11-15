/**
 * Artists: every artist in the music library as a read-only list of songs
 * (the landing page's "Artists" shelf, /artists and /artist/<key>). Nothing is
 * stored: an artist is every song whose credit names them. A credit is split
 * into its artists by artistCredits.ts ("RAYE, 070 Shake" is on RAYE's page
 * and on 070 Shake's; "Earth, Wind & Fire" stays one band), and each artist's
 * key is artistCredits.artistNameKey (folded, channel suffixes dropped, no
 * spaces), so "Barış Manço", "barismanco" and "Barış Manço - Topic" are one
 * artist with key "barismanco". songMatch.normalizeArtist (the primary artist
 * only, for duplicate detection) is not used here.
 *
 * Like Radio's `all` station, songs with an open report are left out: these
 * pages are for listening, and a broken song comes back once it is fixed.
 *
 * GET /api/artists              { count, artists: [{ key, name, count, duration_sec, cover_youtube_id }] }
 *                                most songs first, then by name
 * GET /api/artists/:key/songs   { key, name, count, duration_sec, cover_youtube_id, songs }
 *                                songs are the stations' lean rows, by title; 404 when no song has that key
 *
 * Approved accounts only: the guard's default for /api/... (policyFor in
 * userAuth.js); CLI tokens do not get in.
 */
import express from 'express';
import type { Request, Response, Router } from 'express';
import dbModule from '../../shared/db.ts';
// The library's lean song row (the same as Radio's).
import { OPEN_REPORT_EXISTS_SQL, toLeanSong } from '../../core/library/index.ts';
import type { LeanSong, LeanSongRow } from '../../core/library/index.ts';
import { splitArtistCredit, knownArtistKeys, MAX_KEY } from './artistCredits.ts';
import type { CreditedArtist } from './artistCredits.ts';
import type { Db, LibrarySongRow } from '../../shared/types.ts';

// The live module object: tests replace its functions.
const db: Db = dbModule;

/** The library columns the artist pages read. */
export type ArtistSongRow = LeanSongRow & Pick<LibrarySongRow, 'created_at'>;

/** One artist: every song its credit names it in (rows), and what the list shows of it. */
export interface ArtistGroup<R extends GroupableRow = ArtistSongRow> extends ArtistSummary {
  rows: R[];
}

/** One artist in GET /api/artists. */
export interface ArtistSummary {
  key: string;
  name: string;
  count: number;
  duration_sec: number;
  cover_youtube_id: string | null;
}

/** GET /api/artists/:key/songs */
export interface ArtistSongs extends ArtistSummary {
  songs: LeanSong[];
}

/** What groupArtists reads of a row (the tests pass a few fields only). */
export interface GroupableRow {
  artist?: string | null;
  duration_sec?: number | string | null;
  youtube_id?: string | null;
  created_at?: Date | string | number | null;
}

/**
 * Every distinct credit of the library -> its artists ([{ key, name }]). A
 * library repeats the same few hundred credit strings, so each is split once;
 * "&" splits depend on the whole library (artistCredits.knownArtistKeys).
 */
function creditArtists(rows: GroupableRow[]): Map<string, CreditedArtist[]> {
  const credits = new Map<string, CreditedArtist[] | null>();
  for (const row of rows) credits.set(String(row.artist ?? ''), null);
  const known = knownArtistKeys(credits.keys());
  const isKnown = (key: string) => known.has(key);
  for (const credit of credits.keys()) credits.set(credit, splitArtistCredit(credit, isKnown));
  return credits as Map<string, CreditedArtist[]>;
}

const byTitle = (a: LeanSongRow, b: LeanSongRow) => String(a.title).localeCompare(String(b.title), 'tr', { sensitivity: 'base', numeric: true })
  || String(a.id).localeCompare(String(b.id));

/**
 * rows (library_songs: id, youtube_id, title, artist, duration_sec, sha256,
 * created_at) -> Map key -> { key, name, count, duration_sec, cover_youtube_id, rows }.
 * A song is in the group of every artist its credit names (artistCredits.ts)
 * and keeps its full credit; songs whose credit names nobody are left out.
 * The name is the spelling most of the artist's songs use (ties: the
 * shorter, then A-Z); the cover is the newest song with a YouTube id.
 */
export function groupArtists<R extends GroupableRow>(rows: R[]): Map<string, ArtistGroup<R>> {
  const credits = creditArtists(rows);
  const groups = new Map<string, { key: string; names: Map<string, number>; rows: R[]; duration_sec: number; cover: { id: string; at: number } | null }>();
  for (const row of rows) {
    for (const { key, name } of credits.get(String(row.artist ?? '')) as CreditedArtist[]) {
      let g = groups.get(key);
      if (!g) {
        g = { key, names: new Map(), rows: [], duration_sec: 0, cover: null };
        groups.set(key, g);
      }
      g.rows.push(row);
      g.names.set(name, (g.names.get(name) || 0) + 1);
      if (row.duration_sec !== null && row.duration_sec !== undefined) g.duration_sec += Number(row.duration_sec) || 0;
      if (row.youtube_id) {
        const at = row.created_at ? new Date(row.created_at).getTime() : 0;
        if (!g.cover || at > g.cover.at) g.cover = { id: row.youtube_id, at };
      }
    }
  }
  const out = new Map<string, ArtistGroup<R>>();
  for (const g of groups.values()) {
    const name = [...g.names.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0].length - b[0].length) || a[0].localeCompare(b[0], 'tr'))[0][0];
    out.set(g.key, {
      key: g.key,
      name,
      count: g.rows.length,
      duration_sec: Math.round(g.duration_sec),
      cover_youtube_id: g.cover ? g.cover.id : null,
      rows: g.rows,
    });
  }
  return out;
}

const summaryOf = ({ key, name, count, duration_sec, cover_youtube_id }: ArtistSummary): ArtistSummary => ({ key, name, count, duration_sec, cover_youtube_id });

/** Artists, most songs first, then A-Z (Turkish alphabet). */
export function listArtists(groups: Map<string, ArtistSummary>): ArtistSummary[] {
  return [...groups.values()]
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'tr', { sensitivity: 'base', numeric: true }) || a.key.localeCompare(b.key))
    .map(summaryOf);
}

async function loadGroups(): Promise<Map<string, ArtistGroup>> {
  const r = await db.query<ArtistSongRow>(
    `SELECT id, youtube_id, title, artist, duration_sec, sha256, created_at FROM library_songs WHERE NOT ${OPEN_REPORT_EXISTS_SQL}`
  );
  return groupArtists(r.rows);
}

export function createArtistRouter(): Router {
  const router = express.Router();
  const route = <B>(load: (req: Request<{ key?: string }>) => Promise<B | null>) => async (req: Request<{ key?: string }>, res: Response) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'The music library needs a database' });
    try {
      const body = await load(req);
      if (!body) return res.status(404).json({ error: 'Unknown artist' });
      res.json(body);
    } catch (err) {
      console.error('[artists] error:', (err as Error).message);
      res.status(500).json({ error: 'Failed to load artists' });
    }
  };
  router.get('/api/artists', route(async () => {
    const artists = listArtists(await loadGroups());
    return { count: artists.length, artists };
  }));
  router.get('/api/artists/:key/songs', route(async (req): Promise<ArtistSongs | null> => {
    const key = String(req.params.key || '');
    if (!key || key.length > MAX_KEY) return null;
    const g = (await loadGroups()).get(key);
    if (!g) return null;
    return { ...summaryOf(g), songs: g.rows.slice().sort(byTitle).map(toLeanSong) };
  }));
  return router;
}
