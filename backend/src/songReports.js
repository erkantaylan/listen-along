/**
 * "Mark as broken — needs replacement" reports on library songs
 * (Postgres `library_song_reports`, see db.js).
 *
 * - Any approved user (web session or a token with an owner) can report a
 *   song with an optional short reason; one OPEN report per user per song,
 *   re-reporting updates the reason.
 * - A reporter can withdraw ("unmark") only their own open report.
 * - Replacing the song's audio resolves every open report
 *   (resolution 'replaced', done in library.replaceSong's transaction via
 *   resolveForSong). An admin can dismiss them (resolution 'dismissed').
 *
 * Views never carry user ids of other people: a report is
 * { id, reason, reported_by (name), created_at, mine }.
 */

const db = require('./db');

const MAX_REASON = 200;

class ReportError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cleanReason(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ReportError(400, 'reason must be a string', 'BAD_REQUEST');
  const s = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > MAX_REASON) throw new ReportError(400, `reason is too long (max ${MAX_REASON} characters)`, 'BAD_REQUEST');
  return s || null;
}

// Display name of a reporter: the current account name, else the snapshot.
const NAME_SQL = `COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.reported_by, 'someone')`;

function toView(row, viewerUserId) {
  return {
    id: String(row.id),
    reason: row.reason || null,
    reported_by: row.reporter_name || row.reported_by || 'someone',
    created_at: row.created_at,
    updated_at: row.updated_at,
    mine: !!viewerUserId && !!row.reported_by_user_id && String(row.reported_by_user_id) === String(viewerUserId),
  };
}

/**
 * Open reports of the given songs, oldest first.
 * @returns {Promise<Map<string, object[]>>} song id -> report views
 */
async function openReportsFor(songIds, viewerUserId = null) {
  const ids = [...new Set((songIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length || !db.isAvailable()) return out;
  const r = await db.query(
    `SELECT r.*, ${NAME_SQL} AS reporter_name FROM library_song_reports r
       LEFT JOIN users u ON u.id = r.reported_by_user_id
     WHERE r.song_id = ANY($1::uuid[]) AND r.resolved_at IS NULL
     ORDER BY r.created_at, r.id`,
    [ids]
  );
  for (const row of r.rows) {
    const key = String(row.song_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(toView(row, viewerUserId));
  }
  return out;
}

/** Add `reports` (open, see toView) and `report_count` to public song objects (in place). */
async function attachReports(songs, viewerUserId = null) {
  const list = (songs || []).filter(Boolean);
  if (!list.length) return songs;
  const map = await openReportsFor(list.map((s) => s.id), viewerUserId);
  for (const s of list) {
    s.reports = map.get(String(s.id)) || [];
    s.report_count = s.reports.length;
  }
  return songs;
}

/**
 * Report a song (or update the reason of the caller's open report).
 * @param {{userId: string, name?: string}} actor
 * @returns {Promise<{report: object, created: boolean}>}
 */
async function report(songId, actor, reason) {
  if (!actor || !actor.userId) throw new ReportError(403, 'Only a signed-in account can report songs (a legacy token has no owner)', 'FORBIDDEN');
  const clean = cleanReason(reason);
  const song = await db.query('SELECT id FROM library_songs WHERE id = $1', [songId]);
  if (!song.rows[0]) throw new ReportError(404, 'Song not found', 'NOT_FOUND');
  const r = await db.query(
    `INSERT INTO library_song_reports (song_id, reported_by_user_id, reported_by, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (song_id, reported_by_user_id) WHERE resolved_at IS NULL
     DO UPDATE SET reason = EXCLUDED.reason, reported_by = EXCLUDED.reported_by, updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [songId, actor.userId, actor.name ? String(actor.name).slice(0, 255) : null, clean]
  );
  const row = r.rows[0];
  return { report: toView({ ...row, reporter_name: actor.name }, actor.userId), created: !!row.inserted };
}

/** Withdraw the caller's own open report. @returns {Promise<boolean>} whether one existed */
async function unmark(songId, userId) {
  if (!userId) return false;
  const r = await db.query(
    'DELETE FROM library_song_reports WHERE song_id = $1 AND reported_by_user_id = $2 AND resolved_at IS NULL',
    [songId, userId]
  );
  return r.rowCount > 0;
}

/**
 * Resolve every open report of a song. `client` lets library.replaceSong do
 * it inside its transaction.
 * @returns {Promise<number>} reports resolved
 */
async function resolveForSong(songId, { resolution, userId = null, name = null } = {}, client = db) {
  const r = await client.query(
    `UPDATE library_song_reports
       SET resolved_at = now(), resolution = $2, resolved_by_user_id = $3, resolved_by = $4
     WHERE song_id = $1 AND resolved_at IS NULL`,
    [songId, resolution, userId || null, name ? String(name).slice(0, 255) : null]
  );
  return r.rowCount;
}

/** Admin: dismiss one open report by id. @returns {Promise<object|null>} the row */
async function dismissReport(reportId, name = 'admin') {
  if (!/^\d{1,18}$/.test(String(reportId))) return null;
  const r = await db.query(
    `UPDATE library_song_reports SET resolved_at = now(), resolution = 'dismissed', resolved_by = $2
     WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
    [reportId, name]
  );
  return r.rows[0] || null;
}

/** Song ids with at least one open report (for library.list's filter). */
const OPEN_REPORT_EXISTS_SQL = 'EXISTS (SELECT 1 FROM library_song_reports rr WHERE rr.song_id = library_songs.id AND rr.resolved_at IS NULL)';

module.exports = {
  MAX_REASON,
  ReportError,
  cleanReason,
  openReportsFor,
  attachReports,
  report,
  unmark,
  resolveForSong,
  dismissReport,
  OPEN_REPORT_EXISTS_SQL,
};
