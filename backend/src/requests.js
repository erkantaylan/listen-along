/**
 * Song requests: a web user queued a song that is not in the library. The
 * server does not download it; the request waits until someone uploads it with
 * the CLI (matched by youtube_id or an explicit request_id), or an admin/CLI
 * dismisses it.
 */

const db = require('./db');
const { isUuid } = require('./library');

const STATUSES = ['pending', 'fulfilled', 'dismissed'];

function toPublic(row) {
  return {
    id: row.id,
    youtube_id: row.youtube_id || null,
    url: row.url || null,
    title: row.title || null,
    artist: row.artist || null,
    requested_by: row.requested_by,
    lobby_id: row.lobby_id || null,
    status: row.status,
    song_id: row.song_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function clean(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

/**
 * Create a pending request, or return the existing pending one for the same
 * song in the same lobby (youtube_id, else url, else title).
 * @returns {Promise<{request: object, created: boolean}>}
 */
async function createRequest({ youtubeId, url, title, artist, requestedBy, requestedById, lobbyId }) {
  const fields = {
    youtube_id: clean(youtubeId, 32),
    url: clean(url, 2000),
    title: clean(title, 300),
    artist: clean(artist, 300),
    requested_by: clean(requestedBy, 255) || 'anonymous',
    requested_by_id: clean(requestedById, 255),
    lobby_id: clean(lobbyId, 8),
  };
  if (!fields.youtube_id && !fields.url && !fields.title) throw new Error('A request needs a youtube_id, url or title');

  let existing;
  if (fields.youtube_id) {
    existing = await db.query(
      "SELECT * FROM song_requests WHERE status = 'pending' AND youtube_id = $1 AND lobby_id IS NOT DISTINCT FROM $2 LIMIT 1",
      [fields.youtube_id, fields.lobby_id]
    );
  } else if (fields.url) {
    existing = await db.query(
      "SELECT * FROM song_requests WHERE status = 'pending' AND url = $1 AND lobby_id IS NOT DISTINCT FROM $2 LIMIT 1",
      [fields.url, fields.lobby_id]
    );
  } else {
    existing = await db.query(
      "SELECT * FROM song_requests WHERE status = 'pending' AND youtube_id IS NULL AND url IS NULL AND lower(title) = lower($1) AND lobby_id IS NOT DISTINCT FROM $2 LIMIT 1",
      [fields.title, fields.lobby_id]
    );
  }
  if (existing.rows[0]) return { request: toPublic(existing.rows[0]), created: false };

  const r = await db.query(
    `INSERT INTO song_requests (youtube_id, url, title, artist, requested_by, requested_by_id, lobby_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [fields.youtube_id, fields.url, fields.title, fields.artist, fields.requested_by, fields.requested_by_id, fields.lobby_id]
  );
  return { request: toPublic(r.rows[0]), created: true };
}

async function listRequests({ status = 'pending', limit = 500 } = {}) {
  const params = [];
  let where = '';
  if (status !== 'all') {
    params.push(status);
    where = 'WHERE status = $1';
  }
  params.push(limit);
  const order = status === 'pending' ? 'created_at ASC' : 'updated_at DESC';
  const r = await db.query(`SELECT * FROM song_requests ${where} ORDER BY ${order} LIMIT $${params.length}`, params);
  return r.rows.map(toPublic);
}

async function getRequest(id) {
  if (!isUuid(id)) return null;
  const r = await db.query('SELECT * FROM song_requests WHERE id = $1', [id]);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

/** Mark a request dismissed (e.g. the CLI could not find it). Returns null if missing. */
async function dismissRequest(id) {
  if (!isUuid(id)) return null;
  const r = await db.query(
    "UPDATE song_requests SET status = 'dismissed', updated_at = now() WHERE id = $1 RETURNING *",
    [id]
  );
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

/**
 * Mark pending requests fulfilled by a library song: all pending requests
 * for the song's youtube_id, plus the explicit requestId if given (which may
 * have had no youtube_id, e.g. a text-only request).
 * @returns {Promise<object[]>} the requests that were fulfilled now
 */
async function fulfillRequests(song, requestId = null, extraYoutubeId = null) {
  // extraYoutubeId: the youtube_id the uploader claimed, which can differ from
  // the stored song's when an upload is a byte-identical duplicate (409).
  const ytIds = [...new Set([song.youtube_id, extraYoutubeId].filter(Boolean))];
  const r = await db.query(
    `UPDATE song_requests SET status = 'fulfilled', song_id = $1, updated_at = now()
     WHERE status = 'pending'
       AND (youtube_id = ANY($2::text[]) OR id = $3)
     RETURNING *`,
    [song.id, ytIds, isUuid(requestId) ? requestId : null]
  );
  return r.rows.map(toPublic);
}

module.exports = {
  STATUSES,
  createRequest,
  listRequests,
  getRequest,
  dismissRequest,
  fulfillRequests,
};
