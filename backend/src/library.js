/**
 * Music library: songs uploaded by the listen-along CLI (m4a/AAC), plus the
 * legacy yt-dlp cache migrated in on boot. The server never downloads audio —
 * it only stores, probes and serves what it is given.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const songMatch = require('./songMatch');
const songReports = require('./songReports');

const SONGS_PATH = process.env.SONGS_PATH || '/data/songs';
// New uploads live in a subfolder so they never mix with the legacy cache files.
const LIBRARY_DIR = path.join(SONGS_PATH, 'library');
const UPLOAD_TMP_DIR = path.join(SONGS_PATH, '.upload-tmp');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_UPLOAD_MIME = new Set(['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'application/octet-stream']);

const PUBLIC_COLUMNS = 'id, youtube_id, title, artist, album, duration_sec, source_url, uploaded_by, created_at, sha256, replaced_at, uploaded_by_worker, requested_by';
const MAX_SOURCE_URL_LENGTH = 2048;

function ensureDirs() {
  for (const dir of [SONGS_PATH, LIBRARY_DIR, UPLOAD_TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isYoutubeId(value) {
  return typeof value === 'string' && YOUTUBE_ID_RE.test(value);
}

/**
 * Extract an 11-char YouTube video id from a URL (watch, youtu.be, shorts,
 * music, embed, live) or return the input if it already is a bare id.
 * @returns {string|null}
 */
function parseYoutubeId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (isYoutubeId(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\.|^music\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/').filter(Boolean)[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  return isYoutubeId(id) ? id : null;
}

function youtubeUrl(youtubeId) {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

/**
 * Validate/normalise a song's original source link (e.g. the YouTube watch
 * URL it was downloaded from). Only absolute http(s) URLs up to
 * MAX_SOURCE_URL_LENGTH chars are accepted.
 * @returns {string|null} the normalised URL, or null when invalid
 */
function normalizeSourceUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > MAX_SOURCE_URL_LENGTH) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  const out = u.toString();
  return out.length <= MAX_SOURCE_URL_LENGTH ? out : null;
}

function youtubeThumbnail(youtubeId) {
  return youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : null;
}

/**
 * The url a library song gets in a lobby queue. YouTube songs keep their
 * watch URL (so "open on YouTube" and old queue entries keep working);
 * songs without a YouTube id use a `library:<uuid>` pseudo-URL.
 */
function queueUrlFor(song) {
  return song.youtube_id ? youtubeUrl(song.youtube_id) : `library:${song.id}`;
}

/**
 * Whether a lobby queue (array of entries) already holds this library song:
 * by its queue url (`library:<uuid>` or YouTube watch URL), any other YouTube
 * URL for the same id, or its legacy source_url.
 */
function isQueued(songs, song) {
  if (!song || !Array.isArray(songs)) return false;
  const queueUrl = queueUrlFor(song);
  return songs.some((s) => {
    if (!s || !s.url) return false;
    if (s.url === queueUrl || s.url === `library:${song.id}`) return true;
    if (song.source_url && s.url === song.source_url) return true;
    return !!song.youtube_id && parseYoutubeId(s.url) === song.youtube_id;
  });
}

/** Shape a DB row for the public API. */
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    youtube_id: row.youtube_id || null,
    title: row.title,
    artist: row.artist,
    album: row.album || null,
    duration_sec: row.duration_sec === null || row.duration_sec === undefined ? null : Number(row.duration_sec),
    source_url: row.source_url || (row.youtube_id ? youtubeUrl(row.youtube_id) : null),
    uploaded_by: row.uploaded_by,
    // The downloader (`la worker`) that uploaded it, if any: shown as
    // "uploaded by <worker> (<uploaded_by>)". Who asked for it (a song
    // request or a web download job), if anyone.
    uploaded_by_worker: row.uploaded_by_worker || null,
    requested_by: row.requested_by || null,
    created_at: row.created_at,
    // Changes whenever the audio changes (replace): use it to bust caches,
    // e.g. /api/library/<id>/file?v=<file_version>.
    file_version: row.sha256 ? String(row.sha256).slice(0, 16) : null,
    replaced_at: row.replaced_at || null,
  };
}

/** Build the queue entry fields for a library song. */
function toQueueEntry(song) {
  return {
    url: queueUrlFor(song),
    title: song.artist && song.artist !== 'Unknown' ? `${song.title} - ${song.artist}` : song.title,
    duration: song.duration_sec || 0,
    thumbnail: youtubeThumbnail(song.youtube_id),
  };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Run ffprobe and return its parsed JSON (format + streams), or null when
 * ffprobe fails / the file is not media at all.
 */
function ffprobe(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=format_name,duration:format_tags:stream=codec_type,codec_name:stream_tags:stream_disposition=attached_pic',
        '-of', 'json',
        filePath,
      ]);
    } catch {
      return resolve(null);
    }
    let stdout = '';
    const watchdog = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 20000);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', () => { clearTimeout(watchdog); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(watchdog);
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

/**
 * Decide whether ffprobe output describes an m4a: AAC audio in an MP4
 * container. Cover art (an attached-picture video stream) is allowed; real
 * video streams are not.
 * @returns {{ok: boolean, reason?: string, duration?: number}}
 */
function classifyM4a(probe) {
  if (!probe || !probe.format) return { ok: false, reason: 'File is not a readable media file' };
  const formatName = String(probe.format.format_name || '');
  if (!/(^|,)(mp4|m4a|mov)(,|$)/.test(formatName)) {
    return { ok: false, reason: `Container must be MP4/M4A (got ${formatName || 'unknown'})` };
  }
  const streams = probe.streams || [];
  const audio = streams.filter((s) => s.codec_type === 'audio');
  if (audio.length === 0) return { ok: false, reason: 'File has no audio stream' };
  if (!audio.some((s) => s.codec_name === 'aac')) {
    return { ok: false, reason: `Audio codec must be AAC (got ${audio.map((s) => s.codec_name).join(',')})` };
  }
  const realVideo = streams.filter((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (realVideo.length > 0) return { ok: false, reason: 'File contains a video stream; upload audio only' };
  const duration = parseFloat(probe.format.duration);
  return { ok: true, duration: Number.isFinite(duration) ? duration : undefined };
}

async function probeM4a(filePath) {
  return classifyM4a(await ffprobe(filePath));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function getById(id) {
  if (!isUuid(id)) return null;
  const r = await db.query('SELECT * FROM library_songs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function getByYoutubeId(youtubeId) {
  if (!isYoutubeId(youtubeId)) return null;
  const r = await db.query('SELECT * FROM library_songs WHERE youtube_id = $1', [youtubeId]);
  return r.rows[0] || null;
}

async function getBySha256(sha) {
  const r = await db.query('SELECT * FROM library_songs WHERE sha256 = $1', [sha]);
  return r.rows[0] || null;
}

/**
 * Resolve whatever a queue entry carries as `url` to a library song:
 * `library:<uuid>`, a YouTube URL/id, or a legacy cache URL (source_url).
 */
async function resolveQueueUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  if (url.startsWith('library:')) return getById(url.slice('library:'.length));
  const ytId = parseYoutubeId(url);
  if (ytId) {
    const song = await getByYoutubeId(ytId);
    if (song) return song;
  }
  const r = await db.query('SELECT * FROM library_songs WHERE source_url = $1 LIMIT 1', [url]);
  if (r.rows[0]) return r.rows[0];
  return resolveReplacedUrl(url, ytId);
}

/**
 * A url that pointed at a song before its audio was replaced (its old
 * YouTube id / source link) still resolves to that song. Queue entries are
 * rewritten on replace; this covers anything that kept the old url.
 */
async function resolveReplacedUrl(url, ytId) {
  const r = await db.query(
    `SELECT s.* FROM library_song_replacements r JOIN library_songs s ON s.id = r.song_id
     WHERE ($1::text IS NOT NULL AND r.old_youtube_id = $1) OR r.old_source_url = $2
     ORDER BY r.created_at DESC LIMIT 1`,
    [ytId || null, url]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

/** Return the subset of urls that do NOT resolve to a library song. */
async function findUnavailableUrls(urls) {
  const unique = [...new Set(urls.filter((u) => typeof u === 'string' && u))];
  if (!unique.length) return [];
  const ids = [];
  const ytIds = [];
  for (const url of unique) {
    if (url.startsWith('library:')) { const id = url.slice(8); if (isUuid(id)) ids.push(id); }
    const yt = parseYoutubeId(url);
    if (yt) ytIds.push(yt);
  }
  const r = await db.query(
    `SELECT id::text AS id, youtube_id, source_url FROM library_songs
     WHERE id = ANY($1::uuid[]) OR youtube_id = ANY($2::text[]) OR source_url = ANY($3::text[])`,
    [ids, ytIds, unique]
  );
  const haveIds = new Set(r.rows.map((x) => x.id));
  const haveYt = new Set(r.rows.map((x) => x.youtube_id).filter(Boolean));
  const haveSrc = new Set(r.rows.map((x) => x.source_url).filter(Boolean));
  return unique.filter((url) => {
    if (url.startsWith('library:')) return !haveIds.has(url.slice(8));
    const yt = parseYoutubeId(url);
    if (yt && haveYt.has(yt)) return false;
    return !haveSrc.has(url);
  });
}

/**
 * Search/list library songs. Every whitespace-separated word of q must appear
 * (case-insensitive) in title, artist or album.
 */
async function list({ q = '', limit = 100, offset = 0, youtubeId = null, sort = 'recent', reported = false } = {}) {
  const where = [];
  const params = [];
  const words = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 10);
  for (const w of words) {
    params.push(`%${w.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    where.push(`(title || ' ' || artist || ' ' || COALESCE(album, '')) ILIKE $${params.length}`);
  }
  if (youtubeId) {
    params.push(youtubeId);
    where.push(`youtube_id = $${params.length}`);
  }
  // Only songs marked broken ("needs replacement") by someone.
  if (reported) where.push(songReports.OPEN_REPORT_EXISTS_SQL);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = {
    recent: 'created_at DESC, id',
    title: 'lower(title), lower(artist), id',
    artist: 'lower(artist), lower(title), id',
  }[sort] || 'created_at DESC, id';
  // The reported list, "recent": the most recently reported first.
  const orderFinal = reported && (sort === 'recent' || !sort)
    ? '(SELECT max(rr.updated_at) FROM library_song_reports rr WHERE rr.song_id = library_songs.id AND rr.resolved_at IS NULL) DESC NULLS LAST, id'
    : orderSql;

  const total = await db.query(`SELECT COUNT(*)::int AS n FROM library_songs ${whereSql}`, params);
  params.push(limit, offset);
  const rows = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM library_songs ${whereSql} ORDER BY ${orderFinal} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { songs: rows.rows.map(toPublic), total: total.rows[0].n };
}

/** Best library match for free text (used when YouTube search is unavailable). */
async function findBestTextMatch(text) {
  const { songs } = await list({ q: text, limit: 1, sort: 'title' });
  return songs[0] ? getById(songs[0].id) : null;
}

/** Exact (case-insensitive) title + artist match, e.g. for Spotify links. */
async function findByTitleArtist(title, artist) {
  if (!title || !artist) return null;
  const r = await db.query(
    'SELECT * FROM library_songs WHERE lower(title) = lower($1) AND lower(artist) = lower($2) LIMIT 1',
    [title, artist]
  );
  return r.rows[0] || null;
}

async function insert(song, client = db) {
  const r = await client.query(
    `INSERT INTO library_songs
       (id, youtube_id, title, artist, album, duration_sec, file_path, mime_type, size_bytes, sha256, source_url, uploaded_by, uploaded_by_token, uploaded_by_user_id, meta_key, meta_key_version,
        uploaded_by_worker_id, uploaded_by_worker, upload_job_id, requested_by_user_id, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     RETURNING *`,
    [
      song.id || crypto.randomUUID(),
      song.youtube_id || null,
      song.title,
      song.artist,
      song.album || null,
      song.duration_sec ?? null,
      song.file_path,
      song.mime_type || 'audio/mp4',
      song.size_bytes ?? null,
      song.sha256,
      song.source_url || null,
      song.uploaded_by,
      song.uploaded_by_token || null,
      song.uploaded_by_user_id || null,
      songMatch.metaKey(song.title, song.artist),
      songMatch.META_KEY_VERSION,
      song.uploaded_by_worker_id || null,
      song.uploaded_by_worker || null,
      song.upload_job_id || null,
      song.requested_by_user_id || null,
      song.requested_by || null,
    ]
  );
  return r.rows[0];
}

/** Delete a song row and its file. Returns the deleted row or null. */
async function remove(id) {
  const song = await getById(id);
  if (!song) return null;
  await db.query('DELETE FROM library_songs WHERE id = $1', [id]);
  try { fs.unlinkSync(song.file_path); } catch {}
  return song;
}

// ---------------------------------------------------------------------------
// Upload ingest
// ---------------------------------------------------------------------------

class UploadError extends Error {
  /**
   * @param {number} status - HTTP status
   * @param {string} message
   * @param {object} [song] - the existing song a 409 collided with
   * @param {string} [code] - machine-readable reason, e.g. duplicate_hash
   */
  constructor(status, message, song, code) {
    super(message);
    this.status = status;
    this.song = song;
    if (code) this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/** Reasons a song counts as already in the library, strongest first. */
const DUPLICATE_REASONS = {
  youtube_id: { code: 'already_in_library', exact: true, message: 'A song with this youtube_id is already in the library' },
  sha256: { code: 'duplicate_hash', exact: true, message: 'This exact file is already in the library' },
  metadata: { code: 'duplicate_metadata', exact: false, message: 'A song with the same artist, title and duration (±3s) is already in the library' },
};

function duplicateMatch(kind, song) {
  const r = DUPLICATE_REASONS[kind];
  return { reason: r.code, exact: r.exact, message: r.message, song };
}

function normalizeSha256(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

/**
 * Songs already in the library that match what is about to be uploaded, by
 * youtube_id, file hash and (probable) normalized artist + title with a
 * duration within ±3s. Missing signals are skipped.
 * @param {object} q - { youtube_id, sha256, title, artist, duration_sec, excludeId, metadata }
 * @param {object} [client] - db or a transaction client
 * @returns {Promise<Array<{reason, exact, message, song}>>} strongest first, one entry per song
 */
async function findDuplicates(q = {}, client = db) {
  const matches = [];
  const seen = new Set();
  const push = (kind, row) => {
    if (!row || seen.has(row.id) || (q.excludeId && row.id === q.excludeId)) return;
    seen.add(row.id);
    matches.push(duplicateMatch(kind, row));
  };
  const ytId = q.youtube_id ? parseYoutubeId(String(q.youtube_id)) : null;
  if (ytId) {
    const r = await client.query('SELECT * FROM library_songs WHERE youtube_id = $1', [ytId]);
    push('youtube_id', r.rows[0]);
  }
  const sha = normalizeSha256(q.sha256);
  if (sha) {
    const r = await client.query('SELECT * FROM library_songs WHERE sha256 = $1', [sha]);
    push('sha256', r.rows[0]);
  }
  if (q.metadata !== false) {
    const key = songMatch.metaKey(q.title, q.artist);
    const duration = Number(q.duration_sec);
    if (key && Number.isFinite(duration) && duration > 0) {
      const r = await client.query(
        `SELECT * FROM library_songs
         WHERE meta_key = $1 AND duration_sec IS NOT NULL AND abs(duration_sec - $2) <= $3
         ORDER BY abs(duration_sec - $2), created_at LIMIT 5`,
        [key, duration, songMatch.DURATION_TOLERANCE_SEC]
      );
      for (const row of r.rows) push('metadata', row);
    }
  }
  return matches;
}

/** Postgres advisory lock key for a metadata key (serializes check + insert). */
function metaLockKey(key) {
  return crypto.createHash('sha256').update(`la-meta:${key}`).digest().readInt32BE(0);
}

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Validate the multipart text fields of an upload.
 * source_url is optional (http(s), <= 2048 chars); when absent it is derived
 * from youtube_id.
 * @returns {{title, artist, album, youtube_id, source_url, duration_sec, request_id}}
 * @throws {UploadError} 400 on invalid input
 */
function validateUploadFields(body = {}) {
  const title = cleanText(body.title, 300);
  const artist = cleanText(body.artist, 300);
  const album = cleanText(body.album, 300) || null;
  if (!title) throw new UploadError(400, 'title is required');
  if (!artist) throw new UploadError(400, 'artist is required');

  let youtube_id = null;
  if (body.youtube_id !== undefined && String(body.youtube_id).trim() !== '') {
    youtube_id = parseYoutubeId(String(body.youtube_id));
    if (!youtube_id) throw new UploadError(400, 'youtube_id must be an 11-character YouTube video id');
  }

  let source_url = null;
  if (body.source_url !== undefined && body.source_url !== null && String(body.source_url).trim() !== '') {
    source_url = normalizeSourceUrl(String(body.source_url));
    if (!source_url) {
      throw new UploadError(400, `source_url must be an http(s) URL of at most ${MAX_SOURCE_URL_LENGTH} characters`);
    }
  } else if (youtube_id) {
    source_url = youtubeUrl(youtube_id);
  }

  let duration_sec = null;
  if (body.duration_sec !== undefined && String(body.duration_sec).trim() !== '') {
    duration_sec = Number(body.duration_sec);
    if (!Number.isFinite(duration_sec) || duration_sec < 0 || duration_sec > 24 * 3600) {
      throw new UploadError(400, 'duration_sec must be a non-negative number of seconds');
    }
  }

  let request_id = null;
  if (body.request_id !== undefined && String(body.request_id).trim() !== '') {
    request_id = String(body.request_id).trim();
    if (!isUuid(request_id)) throw new UploadError(400, 'request_id must be a UUID');
  }

  // Upload even when a song with the same artist/title/duration exists
  // (metadata matches are only "probable" duplicates).
  const allow_similar = ['1', 'true', 'yes', 'on'].includes(String(body.allow_similar ?? '').trim().toLowerCase());

  return { title, artist, album, youtube_id, source_url, duration_sec, request_id, allow_similar };
}

/**
 * The on-disk temp path of a multer upload, resolved inside UPLOAD_TMP_DIR.
 * multer names temp files itself (`<uuid>.part`), so this only guards against
 * a path that somehow points elsewhere.
 * @throws {UploadError} 400 if the path is outside the upload temp dir
 */
function uploadTmpPath(file) {
  const root = path.resolve(UPLOAD_TMP_DIR);
  const resolved = path.resolve(root, path.basename(String((file && file.path) || '')));
  if (!resolved.startsWith(root + path.sep)) throw new UploadError(400, 'Bad upload temp path');
  return resolved;
}

/** Best-effort delete of a multer upload's temp file. */
function removeUploadTmp(file) {
  try { fs.rmSync(uploadTmpPath(file), { force: true }); } catch {}
}

function validateUploadFileMeta(file) {
  if (!file) throw new UploadError(400, 'file is required (multipart field "file")');
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext !== '.m4a') throw new UploadError(400, 'Only .m4a files are accepted');
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime && !ALLOWED_UPLOAD_MIME.has(mime)) {
    throw new UploadError(400, `Unsupported content type ${mime}; expected audio/mp4`);
  }
}

/**
 * Ingest an uploaded temp file into the library. Always consumes (moves or
 * deletes) the temp file.
 * @param {{path, originalname, mimetype, size}} file - multer file
 * @param {object} fields - validated fields (validateUploadFields)
 * @param {{name: string, id: string, userId?: string}} uploader - req.apiUser:
 *   name is credited in uploaded_by, id is the token, userId its owner (or null)
 * @returns {Promise<object>} inserted DB row
 * @throws {UploadError} 400 invalid file, 409 duplicate (err.song set)
 */
async function ingestUpload(file, fields, uploader) {
  const tmpPath = uploadTmpPath(file);
  let finalPath = null;
  try {
    const probe = await probeM4a(tmpPath);
    if (!probe.ok) throw new UploadError(400, probe.reason);

    const sha = await sha256File(tmpPath);
    const duration = fields.duration_sec ?? probe.duration ?? null;
    const query = {
      youtube_id: fields.youtube_id, sha256: sha, title: fields.title, artist: fields.artist,
      duration_sec: duration, metadata: !fields.allow_similar,
    };
    const rejectDuplicate = (matches) => {
      const m = matches[0];
      if (m) throw new UploadError(409, m.message, m.song, m.reason);
    };
    // Cheap check before touching the library dir; repeated under the lock.
    rejectDuplicate(await findDuplicates(query));

    ensureDirs();
    const id = crypto.randomUUID();
    finalPath = path.join(LIBRARY_DIR, `${id}.m4a`);
    fs.renameSync(tmpPath, finalPath);
    const size = fs.statSync(finalPath).size;
    const row = {
      id,
      youtube_id: fields.youtube_id,
      title: fields.title,
      artist: fields.artist,
      album: fields.album,
      duration_sec: duration,
      file_path: finalPath,
      mime_type: 'audio/mp4',
      size_bytes: size,
      sha256: sha,
      source_url: fields.source_url || (fields.youtube_id ? youtubeUrl(fields.youtube_id) : null),
      uploaded_by: uploader.name,
      uploaded_by_token: uploader.id,
      uploaded_by_user_id: uploader.userId || null,
      // Upload records (jobRecords.uploadContext): worker, job, requester.
      uploaded_by_worker_id: uploader.workerId || null,
      uploaded_by_worker: uploader.workerName || null,
      upload_job_id: uploader.jobId || null,
      requested_by_user_id: uploader.requestedByUserId || null,
      requested_by: uploader.requestedBy || null,
    };

    // Race-safe: youtube_id and sha256 are unique columns; probable
    // (metadata) duplicates are serialized per metadata key with an advisory
    // lock held until commit, and re-checked inside it.
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const key = songMatch.metaKey(fields.title, fields.artist);
      if (key && !fields.allow_similar) await client.query('SELECT pg_advisory_xact_lock($1)', [metaLockKey(key)]);
      rejectDuplicate(await findDuplicates(query, client));
      const inserted = await insert(row, client);
      await client.query('COMMIT');
      finalPath = null; // owned by the row now
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        // Lost a race with a concurrent identical upload.
        const dup = (await findDuplicates({ youtube_id: fields.youtube_id, sha256: sha, metadata: false }))[0];
        throw new UploadError(409, dup ? dup.message : 'Song is already in the library', dup && dup.song, dup ? dup.reason : 'already_in_library');
      }
      throw err;
    } finally {
      client.release();
    }
  } finally {
    if (finalPath) { try { fs.unlinkSync(finalPath); } catch {} }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Replace: new audio (and metadata) for an existing song, same id
// ---------------------------------------------------------------------------

/**
 * Replace the audio file and metadata (title, artist, album, youtube_id,
 * source_url, duration) of an existing library song, keeping its id — every
 * playlist that holds it plays the new file. Writes an audit row to
 * library_song_replacements. The old file is deleted only after the new one
 * is in place and the row is committed. Always consumes the temp file.
 *
 * @param {string} id - library song id
 * @param {object} file - multer file
 * @param {object} fields - validated fields (validateUploadFields)
 * @param {{name: string, id?: string, userId?: string}} actor - who replaces
 *   (req.apiUser for a token; { name, userId } for a web user)
 * @returns {Promise<{song: object, previous: object, resolvedReports: number}>} new
 *   and old rows, and how many open "needs replacement" reports it resolved
 * @throws {UploadError} 400 invalid file, 404 unknown song, 409 the file /
 *   youtube_id belongs to another song (err.song set), or it is the same file
 */
async function replaceSong(id, file, fields, actor) {
  const tmpPath = uploadTmpPath(file);
  let newPath = null;
  try {
    if (!isUuid(id) || !(await getById(id))) throw new UploadError(404, 'Song not found', null, 'not_found');
    const probe = await probeM4a(tmpPath);
    if (!probe.ok) throw new UploadError(400, probe.reason);
    const sha = await sha256File(tmpPath);

    ensureDirs();
    // A new file name: the old file stays untouched until the row points here.
    newPath = path.join(LIBRARY_DIR, `${id}-${crypto.randomBytes(4).toString('hex')}.m4a`);
    fs.renameSync(tmpPath, newPath);
    const size = fs.statSync(newPath).size;

    const client = await db.getClient();
    let previous;
    let updated;
    let resolvedReports = 0;
    try {
      await client.query('BEGIN');
      const cur = await client.query('SELECT * FROM library_songs WHERE id = $1 FOR UPDATE', [id]);
      previous = cur.rows[0];
      if (!previous) throw new UploadError(404, 'Song not found', null, 'not_found');
      if (previous.sha256 === sha) throw new UploadError(409, 'This song already has exactly this file', previous, 'same_file');
      const clash = (await findDuplicates({ youtube_id: fields.youtube_id, sha256: sha, metadata: false, excludeId: id }, client))[0];
      if (clash) {
        throw new UploadError(409, `${clash.message} as another song (${clash.song.id}); replace or delete that one instead`, clash.song, clash.reason);
      }
      const duration = fields.duration_sec ?? probe.duration ?? null;
      const sourceUrl = fields.source_url || (fields.youtube_id ? youtubeUrl(fields.youtube_id) : null);
      const r = await client.query(
        `UPDATE library_songs SET
           youtube_id = $2, title = $3, artist = $4, album = $5, duration_sec = $6,
           file_path = $7, mime_type = 'audio/mp4', size_bytes = $8, sha256 = $9, source_url = $10,
           meta_key = $11, meta_key_version = $12, replaced_at = now()
         WHERE id = $1 RETURNING *`,
        [id, fields.youtube_id || null, fields.title, fields.artist, fields.album || null, duration,
          newPath, size, sha, sourceUrl, songMatch.metaKey(fields.title, fields.artist), songMatch.META_KEY_VERSION]
      );
      updated = r.rows[0];
      await client.query(
        `INSERT INTO library_song_replacements
           (song_id, replaced_by_user_id, replaced_by, replaced_by_token,
            old_youtube_id, old_source_url, old_sha256, old_title, old_artist, old_album, old_duration_sec,
            new_youtube_id, new_source_url, new_sha256, new_title, new_artist, new_album, new_duration_sec)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [id, actor.userId || null, actor.name || null, actor.id || null,
          previous.youtube_id, previous.source_url, previous.sha256, previous.title, previous.artist, previous.album, previous.duration_sec,
          updated.youtube_id, updated.source_url, updated.sha256, updated.title, updated.artist, updated.album, updated.duration_sec]
      );
      // The song is fixed: every open "needs replacement" report is resolved.
      resolvedReports = await songReports.resolveForSong(id, { resolution: 'replaced', userId: actor.userId, name: actor.name }, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        const dup = (await findDuplicates({ youtube_id: fields.youtube_id, sha256: sha, metadata: false, excludeId: id }))[0];
        throw new UploadError(409, dup ? `${dup.message} as another song` : 'Conflicts with another song', dup && dup.song, dup ? dup.reason : 'conflict');
      }
      throw err;
    } finally {
      client.release();
    }
    newPath = null; // owned by the row now
    if (previous.file_path && path.resolve(previous.file_path) !== path.resolve(updated.file_path)) {
      try { fs.unlinkSync(previous.file_path); } catch {}
    }
    return { song: updated, previous, resolvedReports };
  } finally {
    if (newPath) { try { fs.unlinkSync(newPath); } catch {} }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
}

/** Replacement history of a song, newest first. */
async function listReplacements(songId, limit = 20) {
  if (!isUuid(songId)) return [];
  const r = await db.query(
    'SELECT * FROM library_song_replacements WHERE song_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [songId, limit]
  );
  return r.rows;
}

/**
 * Fill / refresh meta_key for songs without one or computed with an older
 * normalization (META_KEY_VERSION). Runs in small batches with a pause in
 * between so it never hogs the database; safe to run concurrently with
 * uploads (each row is updated on its own, keyed by id + old version).
 * @returns {Promise<number>} rows updated
 */
async function backfillMetaKeys({ batchSize = 200, pauseMs = 50 } = {}) {
  if (!db.isAvailable()) return 0;
  let updated = 0;
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const r = await db.query(
      `SELECT id, title, artist FROM library_songs
       WHERE (meta_key_version IS NULL OR meta_key_version < $1) AND id > $2
       ORDER BY id LIMIT $3`,
      [songMatch.META_KEY_VERSION, lastId, batchSize]
    );
    if (!r.rows.length) break;
    for (const row of r.rows) {
      const res = await db.query(
        `UPDATE library_songs SET meta_key = $2, meta_key_version = $3
         WHERE id = $1 AND (meta_key_version IS NULL OR meta_key_version < $3)`,
        [row.id, songMatch.metaKey(row.title, row.artist), songMatch.META_KEY_VERSION]
      );
      updated += res.rowCount;
      lastId = row.id;
    }
    if (r.rows.length < batchSize) break;
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  if (updated) console.log(`[library] Computed duplicate-detection keys for ${updated} song(s)`);
  return updated;
}

// ---------------------------------------------------------------------------
// Legacy cache migration
// ---------------------------------------------------------------------------

const MIME_BY_EXT = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg' };

function mimeForPath(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Title/artist/album tags from a probe, keys lower-cased. MP3/MP4 keep them
 * on the container, but Ogg/Opus keeps them on the audio stream and Matroska
 * /WebM writes them in upper case (ARTIST), so look in both places.
 */
function probeTags(probe) {
  const tags = {};
  const add = (src) => {
    for (const [k, v] of Object.entries(src || {})) {
      const key = k.toLowerCase();
      if (!(key in tags) && typeof v === 'string' && v.trim()) tags[key] = v;
    }
  };
  add(probe && probe.format && probe.format.tags);
  const audio = ((probe && probe.streams) || []).find((st) => st.codec_type === 'audio');
  add(audio && audio.tags);
  return tags;
}

function isAudioProbe(probe) {
  return !!(probe && (probe.streams || []).some((s) => s.codec_type === 'audio'));
}

/**
 * Register everything already in SONGS_PATH (the old yt-dlp cache) into the
 * library, uploaded_by = "server". Idempotent: files whose path or content
 * hash is already registered are skipped. Files keep their format (mp3); no
 * transcoding and no tag rewriting.
 *
 * 1. Rows of the legacy `songs` table with status ready -> title/duration/url
 *    from the DB, youtube_id parsed from the url.
 * 2. Any other top-level audio file in SONGS_PATH (DB record lost) -> title
 *    from embedded tags if present, else the file name.
 * @returns {Promise<{registered: number, skipped: number}>}
 */
async function migrateLegacyCache({ songsPath = SONGS_PATH } = {}) {
  if (!db.isAvailable()) return { registered: 0, skipped: 0 };
  let registered = 0;
  let skipped = 0;

  const known = await db.query('SELECT file_path FROM library_songs');
  const knownPaths = new Set(known.rows.map((r) => r.file_path));

  const register = async (filePath, meta) => {
    if (knownPaths.has(filePath)) { skipped++; return; }
    let stat;
    try { stat = fs.statSync(filePath); } catch { skipped++; return; }
    if (!stat.isFile() || stat.size < 10240) { skipped++; return; }
    const probe = await ffprobe(filePath);
    if (!isAudioProbe(probe)) { skipped++; return; }
    const sha = await sha256File(filePath);
    if (await getBySha256(sha)) { skipped++; knownPaths.add(filePath); return; }
    let youtubeId = meta.youtube_id || null;
    if (youtubeId && await getByYoutubeId(youtubeId)) youtubeId = null; // keep file, drop the clashing id
    const tags = probeTags(probe);
    const probeDuration = parseFloat(probe.format && probe.format.duration);
    try {
      await insert({
        youtube_id: youtubeId,
        title: cleanText(meta.title || tags.title || path.basename(filePath, path.extname(filePath)), 300) || 'Unknown',
        artist: cleanText(meta.artist || tags.artist, 300) || 'Unknown',
        album: cleanText(tags.album, 300) || null,
        duration_sec: meta.duration > 0 ? meta.duration : (Number.isFinite(probeDuration) ? probeDuration : null),
        file_path: filePath,
        mime_type: mimeForPath(filePath),
        size_bytes: stat.size,
        sha256: sha,
        // Keep the old URL (existing queue entries resolve by it); fall back to
        // the watch URL when it is missing/odd but a YouTube id is known.
        source_url: normalizeSourceUrl(meta.source_url) || (meta.youtube_id ? youtubeUrl(meta.youtube_id) : null),
        uploaded_by: 'server',
      });
      knownPaths.add(filePath);
      registered++;
    } catch (err) {
      if (err.code === '23505') { skipped++; return; }
      throw err;
    }
  };

  // 1. legacy songs table (may not exist on a fresh install that never had it)
  let legacyRows = [];
  try {
    const r = await db.query(
      "SELECT url, title, duration, file_path FROM songs WHERE status = 'ready' AND file_path IS NOT NULL ORDER BY created_at"
    );
    legacyRows = r.rows;
  } catch {}
  for (const row of legacyRows) {
    await register(row.file_path, {
      title: row.title && row.title !== 'Unknown' ? row.title : null,
      duration: Number(row.duration) || 0,
      youtube_id: parseYoutubeId(row.url),
      source_url: row.url,
    });
  }

  // 2. orphan files at the top level of the songs dir
  let entries = [];
  try { entries = fs.readdirSync(songsPath, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!MIME_BY_EXT[path.extname(entry.name).toLowerCase()]) continue;
    await register(path.join(songsPath, entry.name), {});
  }

  if (registered > 0) console.log(`[library] Migrated ${registered} legacy cached song(s) into the library (${skipped} skipped)`);
  return { registered, skipped };
}

module.exports = {
  SONGS_PATH,
  LIBRARY_DIR,
  UPLOAD_TMP_DIR,
  MAX_UPLOAD_BYTES,
  UploadError,
  ensureDirs,
  isUuid,
  isYoutubeId,
  parseYoutubeId,
  youtubeUrl,
  normalizeSourceUrl,
  MAX_SOURCE_URL_LENGTH,
  youtubeThumbnail,
  queueUrlFor,
  isQueued,
  toPublic,
  toQueueEntry,
  sha256File,
  ffprobe,
  classifyM4a,
  probeM4a,
  getById,
  getByYoutubeId,
  getBySha256,
  findDuplicates,
  normalizeSha256,
  DUPLICATE_REASONS,
  replaceSong,
  listReplacements,
  backfillMetaKeys,
  resolveQueueUrl,
  findUnavailableUrls,
  findBestTextMatch,
  findByTitleArtist,
  list,
  insert,
  remove,
  validateUploadFields,
  validateUploadFileMeta,
  uploadTmpPath,
  removeUploadTmp,
  ingestUpload,
  migrateLegacyCache,
  mimeForPath,
};
