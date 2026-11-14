/**
 * Download jobs and the worker registry (Postgres: download_jobs,
 * download_workers). The server never downloads audio itself: a job is run by
 * a `la worker` process on someone's own machine (workerHub.js routes them).
 *
 * A job comes from
 *   - a song request (source 'request', automatic: index.js queue:add), or
 *   - the web "Download" box (source 'web', POST /api/jobs, jobRoutes.js), or
 *   - the song dialog's new link (source 'replace', POST /api/jobs/replace): the
 *     video replaces song replace_song_id and keeps the details in replace_*.
 *
 * Only a worker that advertises the 'replace' capability gets a replace job
 * (workerHub.planAssignments): an older one would upload a new, duplicate song.
 *
 * Lifecycle: queued -> assigned (a worker runs it) -> done | failed.
 * A queued job can be cancelled; a failed/cancelled one retried (-> queued).
 * An assigned job whose worker goes away goes back to queued (requeue).
 *
 * Privacy: the worker's hostname / platform / IP are admin-only
 * (adminWorkerView); everyone else sees a worker's name and owner only.
 */

const db = require('./db');
const library = require('./library');
const ytdlp = require('./ytdlp');
const spotify = require('./spotify');

const STATUSES = ['queued', 'assigned', 'done', 'failed', 'cancelled'];
const ACTIVE = ['queued', 'assigned'];
/** The activity log keeps this many of the newest jobs (and up to ACTIVITY_ACTIVE_MAX older active ones). */
const ACTIVITY_LIMIT = 60;
const ACTIVITY_ACTIVE_MAX = 200;
/** A job that lost its worker this many times fails (WORKER_LOST). */
const MAX_ATTEMPTS = 5;

function clean(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

const isUuid = library.isUuid;

// --- Input classification -----------------------------------------------------

/**
 * What a worker should download for a song request: the YouTube video when
 * the request has one, a YouTube link, else a YouTube search for
 * "artist - title" (a Spotify / other link is never handed to yt-dlp).
 * @returns {{input, kind, title}|null}
 */
function requestInput(r) {
  const title = [r.artist, r.title].filter(Boolean).join(' - ') || null;
  if (r.youtube_id && library.isYoutubeId(r.youtube_id)) {
    return { input: library.youtubeUrl(r.youtube_id), kind: 'video', title: title || r.youtube_id };
  }
  const yt = r.url ? library.parseYoutubeId(r.url) : null;
  if (yt) return { input: library.youtubeUrl(yt), kind: 'video', title: title || yt };
  if (title) return { input: title, kind: 'search', title };
  return null;
}

/**
 * Classify what someone pasted into the Download box (no network).
 * @returns {{kind: 'video'|'playlist'|'spotify'|'search', input, youtubeId?}|{error}}
 */
function classifyInput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { error: 'Paste a YouTube or Spotify link, or type a song to search for' };
  if (text.length > 500) return { error: 'That is too long' };
  if (/^https?:\/\//i.test(text)) {
    const listId = ytdlp.parsePlaylistId(text);
    if (listId) return { kind: 'playlist', input: `https://www.youtube.com/playlist?list=${listId}` };
    const id = library.parseYoutubeId(text);
    if (id) return { kind: 'video', input: library.youtubeUrl(id), youtubeId: id };
    let host = '';
    try { host = new URL(text).hostname.toLowerCase(); } catch {}
    if (host === 'open.spotify.com') {
      // Tracks only, as in the queue (songResolver): a playlist, album or
      // artist page would become a search for its name.
      if (spotify.parseSpotifyUrl(text)) return { kind: 'spotify', input: text };
      return { error: 'Only Spotify track links are supported. Paste the link of a single song.' };
    }
    return { error: 'Unsupported link. Paste a YouTube video or playlist link, a Spotify track link, or type a song name.' };
  }
  const id = library.parseYoutubeId(text);
  if (id && /^[A-Za-z0-9_-]{11}$/.test(text)) return { kind: 'video', input: library.youtubeUrl(id), youtubeId: id };
  return { kind: 'search', input: text.replace(/\s+/g, ' ') };
}

// --- Views ----------------------------------------------------------------------

function summaryOf(result) {
  if (!result || typeof result !== 'object' || !result.summary) return null;
  const s = result.summary;
  const n = (k) => (Number.isFinite(Number(s[k])) ? Number(s[k]) : 0);
  return { total: n('total'), uploaded: n('uploaded'), skipped: n('skipped'), failed: n('failed'), replaced: n('replaced') };
}

/**
 * What the requester (and the web UI) sees. No worker machine details: the
 * worker is its name and its owner's name.
 */
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    input: row.input,
    title: row.title || null,
    request_id: row.request_id || null,
    playlist_id: row.playlist_id || null,
    playlist_name: row.playlist_name || null,
    requested_by: row.requested_by || null,
    status: row.status,
    stage: row.stage || null,
    progress: row.progress || null,
    worker: row.worker_name ? { name: row.worker_name, owner: row.worker_owner || null } : null,
    attempts: row.attempts || 0,
    error_code: row.error_code || null,
    error_message: row.error_message || null,
    summary: summaryOf(row.result),
    song: row.song_id ? { id: row.song_id, title: row.song_title || null, artist: row.song_artist || null } : null,
    replace: row.replace_song_id ? {
      song_id: row.replace_song_id,
      title: row.replace_title || null,
      artist: row.replace_artist || null,
      album: row.replace_album || null,
    } : null,
    created_at: row.created_at,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
  };
}

// --- The activity log's row -------------------------------------------------------
// Everyone approved sees it, so nothing a worker wrote as free text is in it: an
// error or a progress line can hold paths of the worker's machine ("Using local
// copy /home/…", yt-dlp's stderr), and no pattern finds every path. The row says
// why with the error CODE (the web has a sentence per code), where with the
// stage and the upload percent, and passes on only notes this server wrote.

/** Progress notes this server sets itself (requeue, settle, cancel): safe for everyone. */
const SERVER_NOTES = new Set([
  'Server restarted',
  'Downloader went away',
  'Downloader reconnected without it',
  'Downloader shut down',
  'Downloader not connected',
  'Uploaded by someone else',
  'Request dismissed',
  'Replaced by an uploaded file',
]);
const STAGES = new Set(['assigned', 'resolving', 'downloading', 'uploading', 'working']);

/** A code is a short identifier, whoever sent it; anything else is dropped. */
function publicErrorCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
}

/** What everyone may know of a running job's progress: a known stage and the upload percent. */
function publicProgress(row) {
  const running = row.status === 'assigned';
  const stage = running && STAGES.has(row.stage) ? row.stage : null;
  const m = running && stage === 'uploading' ? /(\d{1,3})%\s*$/.exec(row.progress || '') : null;
  const percent = m && Number(m[1]) <= 100 ? Number(m[1]) : null;
  return { stage, percent, progress: !running && SERVER_NOTES.has(row.progress) ? row.progress : null };
}

/**
 * The activity log's row: what every approved account may see of a job (the
 * field names of toPublic where they mean the same, so the web words it the
 * same way). Less than the requester gets: no ids of people, workers or
 * requests, no raw input unless it is the video's link, no worker text (see
 * above), and a playlist only when the caller passes one this viewer can see
 * right now (never row.playlist_name: that join knows nothing about who is
 * looking).
 * @param {object} row
 * @param {{id, name}|null} [playlist] - the job's playlist, if the viewer may see it
 */
function toActivity(row, playlist = null) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    input: row.kind === 'video' ? row.input : null,
    title: row.title || (row.kind === 'search' ? row.input : null),
    playlist_id: playlist ? playlist.id : null,
    playlist_name: playlist ? playlist.name || null : null,
    requested_by: row.requested_by || null,
    status: row.status,
    ...publicProgress(row),
    worker: row.worker_name ? { name: row.worker_name, owner: row.worker_owner || null } : null,
    error_code: row.status === 'failed' ? publicErrorCode(row.error_code) : null,
    summary: summaryOf(row.result),
    song: row.song_id ? { id: row.song_id, title: row.song_title || null, artist: row.song_artist || null } : null,
    replace: row.replace_song_id ? { song_id: row.replace_song_id, title: row.replace_title || null, artist: row.replace_artist || null } : null,
    created_at: row.created_at,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    updated_at: row.updated_at || null,
  };
}

/** Admin list: adds the requester's id and the worker id. */
function toAdmin(row) {
  return { ...toPublic(row), requested_by_user_id: row.requested_by_user_id || null, worker_id: row.worker_id || null, result: row.result || null };
}

/** What a worker is sent: just enough to run it (no playlist, no user ids). */
function toWorker(row) {
  return {
    id: row.id,
    kind: row.kind,
    input: row.input,
    title: row.title || null,
    request_id: row.request_id || null,
    requested_by: row.requested_by || null,
    no_playlist: row.kind !== 'playlist',
    ...(row.replace_song_id ? {
      replace: { song_id: row.replace_song_id, title: row.replace_title, artist: row.replace_artist, album: row.replace_album || null },
    } : {}),
  };
}

function workerOwnerName(row) {
  return row.u_display_name || row.u_name || row.u_username || row.owner_name || null;
}

/** Name + owner + live state: what any signed-in user may see of a worker. */
function publicWorkerView(row, live) {
  return {
    id: row.id,
    name: row.name,
    owner: workerOwnerName(row),
    online: !!live,
    busy: !!(live && live.currentJobId),
  };
}

/** Everything, for the admin page only (IP, machine, versions). */
function adminWorkerView(row, live) {
  return {
    ...publicWorkerView(row, live),
    owner_id: row.user_id || null,
    legacy_token: !row.user_id,
    hostname: row.hostname || null,
    platform: row.platform || null,
    arch: row.arch || null,
    os_release: row.os_release || null,
    cli_version: row.cli_version || null,
    ytdlp_version: row.ytdlp_version || null,
    node_version: row.node_version || null,
    last_ip: row.last_ip || null,
    jobs_done: row.jobs_done || 0,
    jobs_failed: row.jobs_failed || 0,
    created_at: row.created_at,
    last_connected_at: row.last_connected_at || null,
    last_seen_at: row.last_seen_at || null,
    connected_since: live ? new Date(live.connectedAt).toISOString() : null,
    current_job_id: live ? live.currentJobId || null : null,
  };
}

const JOB_SELECT = `
  SELECT j.*, l.name AS playlist_name, s.title AS song_title, s.artist AS song_artist, rs.id AS replace_target_id
  FROM download_jobs j
  LEFT JOIN lobbies l ON l.id = j.playlist_id
  LEFT JOIN library_songs s ON s.id = j.song_id
  LEFT JOIN library_songs rs ON rs.id = j.replace_song_id`;

const WORKER_SELECT = `
  SELECT w.*, u.display_name AS u_display_name, u.name AS u_name, u.username AS u_username
  FROM download_workers w LEFT JOIN users u ON u.id = w.user_id`;

// --- Jobs -----------------------------------------------------------------------

async function getJob(id) {
  if (!isUuid(id)) return null;
  const r = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  return r.rows[0] || null;
}

/**
 * @param {object} f - { source, kind, input, title, requestId, playlistId, requestedByUserId, requestedBy }
 * @returns {Promise<object>} the row
 */
async function createJob(f) {
  const input = clean(f.input, 2000);
  if (!input) throw new Error('A job needs an input');
  const r = await db.query(
    `INSERT INTO download_jobs (source, kind, input, title, request_id, playlist_id, requested_by_user_id, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      f.source === 'request' ? 'request' : 'web',
      clean(f.kind, 16) || 'search',
      input,
      clean(f.title, 300),
      isUuid(f.requestId) ? f.requestId : null,
      clean(f.playlistId, 8),
      isUuid(f.requestedByUserId) ? f.requestedByUserId : null,
      clean(f.requestedBy, 255),
    ]
  );
  return getJob(r.rows[0].id);
}

/**
 * A job that downloads a YouTube video and replaces a song with it.
 * @param {object} f - { song, youtubeId, title, artist, album, requestedByUserId, requestedBy }
 * @returns {Promise<object>} the row
 * @throws a pg 23505 when the song already has an active replace job
 */
async function createReplaceJob(f) {
  const label = [f.artist, f.title].filter(Boolean).join(' - ') || f.title;
  const r = await db.query(
    `INSERT INTO download_jobs (source, kind, input, title, requested_by_user_id, requested_by, replace_song_id, replace_title, replace_artist, replace_album)
     VALUES ('replace', 'video', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [library.youtubeUrl(f.youtubeId), clean(label, 300), isUuid(f.requestedByUserId) ? f.requestedByUserId : null, clean(f.requestedBy, 255), f.song.id, f.title, f.artist, f.album || null]
  );
  return getJob(r.rows[0].id);
}

/** The song's active replace job (at most one), whoever asked for it. */
async function activeReplaceJob(songId) {
  if (!isUuid(songId)) return null;
  const r = await db.query(`${JOB_SELECT} WHERE j.replace_song_id = $1 AND j.status = ANY($2::text[]) LIMIT 1`, [songId, ACTIVE]);
  return r.rows[0] || null;
}

/** This user's newest replace job for the song: what the dialog shows. */
async function latestReplaceJob(songId, userId) {
  if (!isUuid(songId) || !isUuid(userId)) return null;
  const r = await db.query(`${JOB_SELECT} WHERE j.replace_song_id = $1 AND j.requested_by_user_id = $2 ORDER BY j.created_at DESC LIMIT 1`, [songId, userId]);
  return r.rows[0] || null;
}

const SONG_GONE = 'The song to replace was deleted from the library';

/** A replace job whose song is gone fails, whatever state it is in. */
async function failTargetGone(jobId) {
  const r = await db.query(
    `UPDATE download_jobs SET status = 'failed', error_code = 'SONG_DELETED', error_message = $2,
       stage = NULL, progress = NULL, finished_at = now(), updated_at = now()
     WHERE id = $1 AND status = ANY($3::text[]) RETURNING id`,
    [jobId, SONG_GONE, ACTIVE]
  );
  return r.rows[0] ? getJob(jobId) : null;
}

/** A song was deleted: its active replace jobs fail (a worker's upload is then refused). */
async function failReplaceJobsForSong(songId) {
  if (!isUuid(songId)) return [];
  const r = await db.query(`SELECT id FROM download_jobs WHERE replace_song_id = $1 AND status = ANY($2::text[])`, [songId, ACTIVE]);
  return (await Promise.all(r.rows.map((x) => failTargetGone(x.id)))).filter(Boolean);
}

/** Someone uploaded a file for the song: the file wins, active jobs are dropped. */
async function cancelReplaceJobsForSong(songId, reason) {
  if (!isUuid(songId)) return [];
  const r = await db.query(
    `UPDATE download_jobs SET status = 'cancelled', progress = $2, stage = NULL, finished_at = now(), updated_at = now()
     WHERE replace_song_id = $1 AND status = ANY($3::text[]) RETURNING id`,
    [songId, clean(reason, 300), ACTIVE]
  );
  return Promise.all(r.rows.map((x) => getJob(x.id)));
}

/**
 * The job for a new song request (one per request; an existing active job
 * for it is returned as is). null if the request has nothing to search for.
 */
async function createForRequest(request, { requestedByUserId = null } = {}) {
  const what = requestInput(request);
  if (!what) return null;
  const existing = await db.query(
    `SELECT id FROM download_jobs WHERE request_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
    [request.id, ACTIVE]
  );
  if (existing.rows[0]) return getJob(existing.rows[0].id);
  return createJob({
    source: 'request',
    kind: what.kind,
    input: what.input,
    title: what.title,
    requestId: request.id,
    playlistId: request.lobby_id || null,
    requestedByUserId: requestedByUserId || request.requested_by_id || null,
    requestedBy: request.requested_by,
  });
}

/** Oldest first. */
async function listQueued(limit = 200) {
  const r = await db.query(`${JOB_SELECT} WHERE j.status = 'queued' ORDER BY j.created_at, j.id LIMIT $1`, [limit]);
  return r.rows;
}

async function listForUser(userId, { limit = 50, sources = null } = {}) {
  if (!isUuid(userId)) return [];
  const r = await db.query(
    `${JOB_SELECT} WHERE j.requested_by_user_id = $1 AND ($3::text[] IS NULL OR j.source = ANY($3::text[])) ORDER BY j.created_at DESC LIMIT $2`,
    [userId, limit, sources]);
  return r.rows;
}

/**
 * The activity log: the newest `limit` jobs of everyone plus every job still
 * waiting or running (however old), newest first.
 */
async function listActivity({ limit = ACTIVITY_LIMIT } = {}) {
  const r = await db.query(
    `${JOB_SELECT} WHERE j.status = ANY($2::text[])
       OR j.id IN (SELECT id FROM download_jobs ORDER BY created_at DESC, id LIMIT $1)
     ORDER BY j.created_at DESC, j.id LIMIT $3`,
    [limit, ACTIVE, limit + ACTIVITY_ACTIVE_MAX]);
  return r.rows;
}

async function listAll({ status = 'all', limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (status === 'active') where = `WHERE j.status = ANY('{queued,assigned}'::text[])`;
  else if (status !== 'all') { params.push(status); where = 'WHERE j.status = $1'; }
  params.push(limit);
  const r = await db.query(`${JOB_SELECT} ${where} ORDER BY (j.status = 'assigned') DESC, (j.status = 'queued') DESC, j.created_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

async function countByStatus() {
  const r = await db.query('SELECT status, count(*)::int AS n FROM download_jobs GROUP BY status');
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of r.rows) counts[row.status] = row.n;
  return counts;
}

/**
 * queued -> assigned to this worker. null when someone else got it first
 * (or it was cancelled meanwhile).
 */
async function assign(jobId, worker) {
  const r = await db.query(
    `UPDATE download_jobs SET status = 'assigned', worker_id = $2, worker_name = $3, worker_owner = $4,
       attempts = attempts + 1, stage = 'assigned', progress = NULL, started_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'queued' RETURNING id`,
    [jobId, worker.id, worker.name, worker.ownerName || null]
  );
  return r.rows[0] ? getJob(jobId) : null;
}

/**
 * A worker that reconnects still running `jobId` takes it back: it must be
 * queued (requeued meanwhile) or still assigned to this same worker.
 */
async function reclaim(jobId, worker) {
  if (!isUuid(jobId)) return null;
  const r = await db.query(
    `UPDATE download_jobs SET status = 'assigned', worker_id = $2, worker_name = $3, worker_owner = $4, updated_at = now()
     WHERE id = $1 AND (status = 'queued' OR (status = 'assigned' AND worker_id = $2))
       AND ($5 OR replace_song_id IS NULL) RETURNING id`,
    [jobId, worker.id, worker.name, worker.ownerName || null, !!worker.canReplace]
  );
  return r.rows[0] ? getJob(jobId) : null;
}

/**
 * assigned -> queued again (worker gone / gave it back). With workerId, only
 * if it is still that worker's. After MAX_ATTEMPTS it fails instead.
 * @returns {Promise<object|null>} the updated row, or null if nothing changed
 */
async function requeue(jobId, { workerId = null, reason = null } = {}) {
  const params = [jobId, MAX_ATTEMPTS, clean(reason, 300)];
  let mine = '';
  if (workerId) { params.push(workerId); mine = `AND worker_id = $${params.length}`; }
  const r = await db.query(
    `UPDATE download_jobs SET
       status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
       error_code = CASE WHEN attempts >= $2 THEN 'WORKER_LOST' ELSE error_code END,
       error_message = CASE WHEN attempts >= $2 THEN 'The downloader running it went away too many times' ELSE error_message END,
       finished_at = CASE WHEN attempts >= $2 THEN now() ELSE NULL END,
       stage = NULL, progress = $3, updated_at = now()
     WHERE id = $1 AND status = 'assigned' ${mine} RETURNING id`,
    params
  );
  return r.rows[0] ? getJob(jobId) : null;
}

/** Boot: nothing is connected yet, so no job can be running. */
async function requeueAllAssigned() {
  const r = await db.query(
    `UPDATE download_jobs SET status = 'queued', stage = NULL, progress = 'Server restarted', updated_at = now()
     WHERE status = 'assigned' RETURNING id`
  );
  return r.rows.length;
}

async function setProgress(jobId, workerId, { stage, message }) {
  await db.query(
    `UPDATE download_jobs SET stage = $3, progress = $4, updated_at = now()
     WHERE id = $1 AND status = 'assigned' AND worker_id = $2`,
    [jobId, workerId, clean(stage, 32), clean(message, 500)]
  );
}

/** Keep what the profile / admin pages need from a worker's batch result. */
function trimResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const summary = r.summary && typeof r.summary === 'object' ? r.summary : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const items = (Array.isArray(r.results) ? r.results : []).slice(0, 500).map((x) => ({
    status: clean(x && x.status, 32),
    title: clean(x && x.title, 300),
    artist: clean(x && x.artist, 300),
    youtube_id: clean(x && x.youtube_id, 32),
    song_id: isUuid(x && x.song_id) ? x.song_id : null,
    code: clean(x && x.code, 64),
    error: clean(x && x.error, 500),
    reason: clean(x && x.reason, 200),
  }));
  return {
    summary: { total: num(summary.total), uploaded: num(summary.uploaded), skipped: num(summary.skipped), failed: num(summary.failed), replaced: num(summary.replaced) },
    results: items,
  };
}

/**
 * A worker finished running a job. Accepted while the job is active (first
 * finisher wins if it was handed to two workers); the reporting worker is
 * recorded as the one that did it.
 * @returns {Promise<{job: object, songIds: string[]}|null>} null if it was already finished
 */
async function finish(jobId, worker, result) {
  const trimmed = trimResult(result);
  const current = await getJob(jobId);
  // A replace job only counts when the song was replaced: an upload or a
  // skip would not have changed it.
  const ok = current && current.replace_song_id
    ? trimmed.summary.replaced > 0
    : trimmed.summary.uploaded + trimmed.summary.skipped > 0;
  const firstFail = trimmed.results.find((x) => x.status === 'failed');
  const songIds = [...new Set(trimmed.results.filter((x) => ['uploaded', 'skipped', 'replaced'].includes(x.status) && x.song_id).map((x) => x.song_id))];
  const status = ok ? 'done' : 'failed';
  const errorCode = ok ? null : clean((result && result.error_code) || (firstFail && firstFail.code) || 'NOTHING_DOWNLOADED', 64);
  const errorMessage = ok ? null : clean((result && result.error_message) || (firstFail && firstFail.error) || 'Nothing was downloaded', 500);
  const r = await db.query(
    `UPDATE download_jobs SET status = $3, result = $4, error_code = $5, error_message = $6,
       song_id = $7, worker_id = $2, worker_name = $8, worker_owner = $9,
       stage = NULL, progress = NULL, finished_at = now(), updated_at = now()
     WHERE id = $1 AND status = ANY($10::text[]) RETURNING id`,
    [jobId, worker.id, status, JSON.stringify(trimmed), errorCode, errorMessage, songIds[0] || null,
      worker.name, worker.ownerName || null, ACTIVE]
  );
  if (!r.rows[0]) return null;
  await db.query(
    `UPDATE download_workers SET ${ok ? 'jobs_done = jobs_done + 1' : 'jobs_failed = jobs_failed + 1'}, last_seen_at = now() WHERE id = $1`,
    [worker.id]
  ).catch(() => {});
  return { job: await getJob(jobId), songIds };
}

/** Requester (or admin): a queued job is dropped. */
async function cancel(jobId, { userId = null } = {}) {
  if (!isUuid(jobId)) return null;
  const params = [jobId];
  let mine = '';
  if (userId) { params.push(userId); mine = `AND requested_by_user_id = $${params.length}`; }
  const r = await db.query(
    `UPDATE download_jobs SET status = 'cancelled', finished_at = now(), updated_at = now(), stage = NULL
     WHERE id = $1 AND status = 'queued' ${mine} RETURNING id`,
    params
  );
  return r.rows[0] ? getJob(jobId) : null;
}

/** Requester (or admin): a failed / cancelled job goes back in the queue. */
async function retry(jobId, { userId = null } = {}) {
  if (!isUuid(jobId)) return null;
  const params = [jobId];
  let mine = '';
  if (userId) { params.push(userId); mine = `AND requested_by_user_id = $${params.length}`; }
  let r;
  try {
    r = await db.query(
      `UPDATE download_jobs SET status = 'queued', attempts = 0, error_code = NULL, error_message = NULL,
         result = NULL, worker_id = NULL, worker_name = NULL, worker_owner = NULL, stage = NULL,
         progress = NULL, started_at = NULL, finished_at = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('failed', 'cancelled') ${mine} RETURNING id`,
      params
    );
  } catch (err) {
    if (err.code === '23505') return null; // the song has another active replace job
    throw err;
  }
  if (!r.rows[0]) return null;
  const row = await getJob(jobId);
  return row.replace_song_id && !row.replace_target_id ? failTargetGone(jobId) : row;
}

/**
 * Requests fulfilled by an upload (from any uploader): their queued jobs are
 * done — nothing left to download. Assigned ones finish on their own (the
 * upload answers "already in the library").
 */
async function settleForFulfilledRequests(requestIds, song) {
  const ids = (requestIds || []).filter(isUuid);
  if (!ids.length) return [];
  const r = await db.query(
    `UPDATE download_jobs SET status = 'done', song_id = $2, progress = 'Uploaded by someone else',
       finished_at = now(), updated_at = now()
     WHERE request_id = ANY($1::uuid[]) AND status = 'queued' RETURNING id`,
    [ids, song && isUuid(song.id) ? song.id : null]
  );
  return Promise.all(r.rows.map((x) => getJob(x.id)));
}

/** A dismissed request's queued job is cancelled. */
async function cancelForRequest(requestId) {
  if (!isUuid(requestId)) return [];
  const r = await db.query(
    `UPDATE download_jobs SET status = 'cancelled', progress = 'Request dismissed', finished_at = now(), updated_at = now()
     WHERE request_id = $1 AND status = 'queued' RETURNING id`,
    [requestId]
  );
  return Promise.all(r.rows.map((x) => getJob(x.id)));
}

// --- Workers --------------------------------------------------------------------

async function getWorker(id) {
  if (!isUuid(id)) return null;
  const r = await db.query(`${WORKER_SELECT} WHERE w.id = $1`, [id]);
  return r.rows[0] || null;
}

async function listWorkers() {
  const r = await db.query(`${WORKER_SELECT} ORDER BY w.last_connected_at DESC NULLS LAST, w.created_at DESC`);
  return r.rows;
}

async function listUserWorkers(userId) {
  if (!isUuid(userId)) return [];
  const r = await db.query(`${WORKER_SELECT} WHERE w.user_id = $1 ORDER BY w.last_connected_at DESC NULLS LAST`, [userId]);
  return r.rows;
}

/**
 * Register (or update) the worker a `la worker` process is: one row per
 * owner + name (case-insensitive); a legacy ownerless token keys on the token.
 * @param {object} apiUser - tokens.verifyToken() result
 * @param {object} hello - the worker's hello message
 * @param {string} ip
 */
async function registerWorker(apiUser, hello, ip) {
  const name = clean(hello.name, 100) || clean(hello.hostname, 100) || 'worker';
  const fields = [
    clean(hello.hostname, 255), clean(hello.platform, 32), clean(hello.arch, 32), clean(hello.os_release, 128),
    clean(hello.cli_version, 32), clean(hello.ytdlp_version, 64), clean(hello.node_version, 32), clean(ip, 64),
    clean(apiUser.name, 255),
  ];
  const key = apiUser.userId
    ? await db.query('SELECT id FROM download_workers WHERE user_id = $1 AND lower(name) = lower($2) LIMIT 1', [apiUser.userId, name])
    : await db.query('SELECT id FROM download_workers WHERE user_id IS NULL AND token_id = $1 AND lower(name) = lower($2) LIMIT 1', [apiUser.id, name]);
  let id;
  if (key.rows[0]) {
    id = key.rows[0].id;
    await db.query(
      `UPDATE download_workers SET name = $2, hostname = $3, platform = $4, arch = $5, os_release = $6,
         cli_version = $7, ytdlp_version = $8, node_version = $9, last_ip = $10, owner_name = $11,
         token_id = $12, last_connected_at = now(), last_seen_at = now()
       WHERE id = $1`,
      [id, name, ...fields, apiUser.id]
    );
  } else {
    const r = await db.query(
      `INSERT INTO download_workers (name, hostname, platform, arch, os_release, cli_version, ytdlp_version,
         node_version, last_ip, owner_name, token_id, user_id, last_connected_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now()) RETURNING id`,
      [name, ...fields, apiUser.id, apiUser.userId || null]
    );
    id = r.rows[0].id;
  }
  return getWorker(id);
}

async function touchWorker(id) {
  await db.query('UPDATE download_workers SET last_seen_at = now() WHERE id = $1', [id]).catch(() => {});
}

/**
 * May this token upload as this worker? Its owner's, or (legacy token) the
 * token's own.
 */
async function workerForUpload(workerId, apiUser) {
  const w = await getWorker(workerId);
  if (!w) return null;
  if (w.user_id ? w.user_id === apiUser.userId : w.token_id === apiUser.id) return w;
  return null;
}

module.exports = {
  STATUSES,
  MAX_ATTEMPTS,
  requestInput,
  classifyInput,
  toPublic,
  toActivity,
  publicProgress,
  toAdmin,
  toWorker,
  publicWorkerView,
  adminWorkerView,
  workerOwnerName,
  trimResult,
  getJob,
  createJob,
  createForRequest,
  createReplaceJob,
  activeReplaceJob,
  latestReplaceJob,
  failTargetGone,
  failReplaceJobsForSong,
  cancelReplaceJobsForSong,
  listQueued,
  listForUser,
  listAll,
  listActivity,
  ACTIVITY_LIMIT,
  countByStatus,
  assign,
  reclaim,
  requeue,
  requeueAllAssigned,
  setProgress,
  finish,
  cancel,
  retry,
  settleForFulfilledRequests,
  cancelForRequest,
  getWorker,
  listWorkers,
  listUserWorkers,
  registerWorker,
  touchWorker,
  workerForUpload,
};

/**
 * Upload records: who/what is behind a CLI upload. The worker (worker_id
 * field: must be the token's own worker), the job it ran (job_id field), and
 * who asked for the song (the job's requester, else the song request's).
 * A job that came from a song request also supplies its request_id.
 * Bad or foreign ids are ignored (the upload itself still counts).
 * @returns {Promise<{workerId, workerName, jobId, requestedByUserId, requestedBy, job, requestId}>}
 */
async function uploadContext(apiUser, body = {}, fields = {}) {
  const ctx = { workerId: null, workerName: null, jobId: null, requestedByUserId: null, requestedBy: null, job: null, requestId: fields.request_id || null };
  if (isUuid(body.worker_id)) {
    const w = await workerForUpload(body.worker_id, apiUser).catch(() => null);
    if (w) { ctx.workerId = w.id; ctx.workerName = w.name; }
  }
  if (isUuid(body.job_id)) {
    const job = await getJob(body.job_id).catch(() => null);
    // The job must be one this worker ran (or was given).
    if (job && ctx.workerId && job.worker_id === ctx.workerId) {
      ctx.job = job;
      ctx.jobId = job.id;
      ctx.requestedByUserId = job.requested_by_user_id || null;
      ctx.requestedBy = job.requested_by || null;
      if (!ctx.requestId && job.request_id) ctx.requestId = job.request_id;
    }
  }
  if (!ctx.requestedBy && ctx.requestId) {
    const r = await db.query('SELECT requested_by, requested_by_id FROM song_requests WHERE id = $1', [ctx.requestId]).catch(() => ({ rows: [] }));
    if (r.rows[0]) {
      ctx.requestedBy = r.rows[0].requested_by || null;
      ctx.requestedByUserId = isUuid(r.rows[0].requested_by_id) ? r.rows[0].requested_by_id : null;
    }
  }
  return ctx;
}

module.exports.uploadContext = uploadContext;
