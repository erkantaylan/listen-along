/**
 * Artists: every artist in the music library as a read-only list of songs
 * (the landing page's "Artists" shelf, /artists and /artist/<key>). Nothing is
 * stored: an artist is the songs whose `artist` normalizes to the same key
 * (songMatch.normalizeArtist: folded, featured artists and channel suffixes
 * dropped, the primary artist only, no spaces), so "Barış Manço",
 * "barismanco" and "Barış Manço - Topic" are one artist with key "barismanco".
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
const express = require('express');
const db = require('./db');
const { OPEN_REPORT_EXISTS_SQL } = require('./songReports');
const { normalizeArtist } = require('./songMatch');
const { toStationSong } = require('./stations');

const MAX_KEY = 200;

// normalizeArtist is a handful of regexes; a library repeats the same few
// hundred artist strings, so remember them (bounded, cleared when full).
const keyCache = new Map();
function artistKey(artist) {
  const raw = String(artist ?? '');
  let key = keyCache.get(raw);
  if (key === undefined) {
    key = normalizeArtist(raw).slice(0, MAX_KEY);
    if (keyCache.size >= 5000) keyCache.clear();
    keyCache.set(raw, key);
  }
  return key;
}

/** The artist as shown: the upload's own spelling without YouTube channel suffixes. */
function displayName(artist) {
  return String(artist ?? '').trim()
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s*vevo$/i, '')
    .replace(/\s+official(?:\s+channel)?$/i, '')
    .trim();
}

const byTitle = (a, b) => String(a.title).localeCompare(String(b.title), 'tr', { sensitivity: 'base', numeric: true })
  || String(a.id).localeCompare(String(b.id));

/**
 * rows (library_songs: id, youtube_id, title, artist, duration_sec, sha256,
 * created_at) -> Map key -> { key, name, count, duration_sec, cover_youtube_id, rows }.
 * Songs whose artist normalizes to nothing are left out. The name is the
 * spelling most of the artist's songs use (ties: the shorter, then A-Z); the
 * cover is the newest song with a YouTube id.
 */
function groupArtists(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = artistKey(row.artist);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, names: new Map(), rows: [], duration_sec: 0, cover: null };
      groups.set(key, g);
    }
    g.rows.push(row);
    const name = displayName(row.artist) || String(row.artist).trim();
    g.names.set(name, (g.names.get(name) || 0) + 1);
    if (row.duration_sec !== null && row.duration_sec !== undefined) g.duration_sec += Number(row.duration_sec) || 0;
    if (row.youtube_id) {
      const at = row.created_at ? new Date(row.created_at).getTime() : 0;
      if (!g.cover || at > g.cover.at) g.cover = { id: row.youtube_id, at };
    }
  }
  const out = new Map();
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

const summaryOf = ({ key, name, count, duration_sec, cover_youtube_id }) => ({ key, name, count, duration_sec, cover_youtube_id });

/** Artists, most songs first, then A-Z (Turkish alphabet). */
function listArtists(groups) {
  return [...groups.values()]
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'tr', { sensitivity: 'base', numeric: true }) || a.key.localeCompare(b.key))
    .map(summaryOf);
}

async function loadGroups() {
  const r = await db.query(
    `SELECT id, youtube_id, title, artist, duration_sec, sha256, created_at FROM library_songs WHERE NOT ${OPEN_REPORT_EXISTS_SQL}`
  );
  return groupArtists(r.rows);
}

function createArtistRouter() {
  const router = express.Router();
  const route = (load) => async (req, res) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'The music library needs a database' });
    try {
      const body = await load(req);
      if (!body) return res.status(404).json({ error: 'Unknown artist' });
      res.json(body);
    } catch (err) {
      console.error('[artists] error:', err.message);
      res.status(500).json({ error: 'Failed to load artists' });
    }
  };
  router.get('/api/artists', route(async () => {
    const artists = listArtists(await loadGroups());
    return { count: artists.length, artists };
  }));
  router.get('/api/artists/:key/songs', route(async (req) => {
    const key = String(req.params.key || '');
    if (!key || key.length > MAX_KEY) return null;
    const g = (await loadGroups()).get(key);
    if (!g) return null;
    return { ...summaryOf(g), songs: g.rows.slice().sort(byTitle).map(toStationSong) };
  }));
  return router;
}

module.exports = { createArtistRouter, groupArtists, listArtists, displayName, artistKey };
