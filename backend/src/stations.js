/**
 * Radio stations: a station is "a list of songs from a rule". A rule is a SQL
 * condition on library_songs, and `all` is the first one (every song nobody has
 * marked broken). The server knows the songs; the order is the listener's own
 * (shuffled in the browser, frontend/radio-order.js).
 *
 * GET /api/stations/:id        { id, count, duration_sec }
 * GET /api/stations/:id/songs  the same + songs (lean: no reports or upload details)
 *
 * Paging /api/library for this would take three requests at 2,500 songs, could
 * skip or repeat songs when an upload lands in between, and has no "not broken"
 * filter. These routes are approved accounts only: the guard's default for
 * /api/... (policyFor in userAuth.js); CLI tokens do not get in.
 */
const express = require('express');
const db = require('./db');
const { OPEN_REPORT_EXISTS_SQL } = require('./songReports');

const RULES = new Map([
  ['all', `NOT ${OPEN_REPORT_EXISTS_SQL}`],
]);

function toStationSong(row) {
  return {
    id: row.id,
    youtube_id: row.youtube_id || null,
    title: row.title,
    artist: row.artist,
    duration_sec: row.duration_sec === null || row.duration_sec === undefined ? null : Number(row.duration_sec),
    file_version: row.sha256 ? String(row.sha256).slice(0, 16) : null,
  };
}

async function summary(id) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(duration_sec), 0)::bigint AS duration_sec FROM library_songs WHERE ${RULES.get(id)}`
  );
  return { id, count: r.rows[0].count, duration_sec: Number(r.rows[0].duration_sec) };
}

async function songs(id) {
  const r = await db.query(
    `SELECT id, youtube_id, title, artist, duration_sec, sha256 FROM library_songs WHERE ${RULES.get(id)} ORDER BY id`
  );
  const list = r.rows.map(toStationSong);
  return { id, count: list.length, duration_sec: list.reduce((sum, s) => sum + (s.duration_sec || 0), 0), songs: list };
}

function createStationRouter() {
  const router = express.Router();
  const route = (load) => async (req, res) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'The music library needs a database' });
    if (!RULES.has(req.params.id)) return res.status(404).json({ error: 'Unknown station' });
    try {
      res.json(await load(req.params.id));
    } catch (err) {
      console.error('[stations] error:', err.message);
      res.status(500).json({ error: 'Failed to load the station' });
    }
  };
  router.get('/api/stations/:id', route(summary));
  router.get('/api/stations/:id/songs', route(songs));
  return router;
}

module.exports = { createStationRouter, toStationSong };
