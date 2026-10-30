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

const SONGS_PATH = process.env.SONGS_PATH || '/data/songs';
// New uploads live in a subfolder so they never mix with the legacy cache files.
const LIBRARY_DIR = path.join(SONGS_PATH, 'library');
const UPLOAD_TMP_DIR = path.join(SONGS_PATH, '.upload-tmp');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_UPLOAD_MIME = new Set(['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'application/octet-stream']);

const PUBLIC_COLUMNS = 'id, youtube_id, title, artist, album, duration_sec, source_url, uploaded_by, created_at';
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
    created_at: row.created_at,
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
        '-show_entries', 'format=format_name,duration:format_tags=title,artist,album:stream=codec_type,codec_name:stream_disposition=attached_pic',
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
async function list({ q = '', limit = 100, offset = 0, youtubeId = null, sort = 'recent' } = {}) {
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
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = {
    recent: 'created_at DESC, id',
    title: 'lower(title), lower(artist), id',
    artist: 'lower(artist), lower(title), id',
  }[sort] || 'created_at DESC, id';

  const total = await db.query(`SELECT COUNT(*)::int AS n FROM library_songs ${whereSql}`, params);
  params.push(limit, offset);
  const rows = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM library_songs ${whereSql} ORDER BY ${orderSql} LIMIT $${params.length - 1} OFFSET $${params.length}`,
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

async function insert(song) {
  const r = await db.query(
    `INSERT INTO library_songs
       (id, youtube_id, title, artist, album, duration_sec, file_path, mime_type, size_bytes, sha256, source_url, uploaded_by, uploaded_by_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
  constructor(status, message, song) {
    super(message);
    this.status = status;
    this.song = song;
  }
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

  return { title, artist, album, youtube_id, source_url, duration_sec, request_id };
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
 * @param {{name: string, id: string}} uploader - the token owner
 * @returns {Promise<object>} inserted DB row
 * @throws {UploadError} 400 invalid file, 409 duplicate (err.song set)
 */
async function ingestUpload(file, fields, uploader) {
  const tmpPath = file.path;
  try {
    const probe = await probeM4a(tmpPath);
    if (!probe.ok) throw new UploadError(400, probe.reason);

    if (fields.youtube_id) {
      const existing = await getByYoutubeId(fields.youtube_id);
      if (existing) throw new UploadError(409, 'A song with this youtube_id is already in the library', existing);
    }
    const sha = await sha256File(tmpPath);
    const sameFile = await getBySha256(sha);
    if (sameFile) throw new UploadError(409, 'This exact file is already in the library', sameFile);

    ensureDirs();
    const id = crypto.randomUUID();
    const finalPath = path.join(LIBRARY_DIR, `${id}.m4a`);
    fs.renameSync(tmpPath, finalPath);
    const size = fs.statSync(finalPath).size;
    try {
      return await insert({
        id,
        youtube_id: fields.youtube_id,
        title: fields.title,
        artist: fields.artist,
        album: fields.album,
        duration_sec: fields.duration_sec ?? probe.duration ?? null,
        file_path: finalPath,
        mime_type: 'audio/mp4',
        size_bytes: size,
        sha256: sha,
        source_url: fields.source_url || (fields.youtube_id ? youtubeUrl(fields.youtube_id) : null),
        uploaded_by: uploader.name,
        uploaded_by_token: uploader.id,
      });
    } catch (err) {
      try { fs.unlinkSync(finalPath); } catch {}
      if (err.code === '23505') {
        // Lost a race with a concurrent identical upload.
        const dup = (fields.youtube_id && await getByYoutubeId(fields.youtube_id)) || await getBySha256(sha);
        throw new UploadError(409, 'Song is already in the library', dup);
      }
      throw err;
    }
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Legacy cache migration
// ---------------------------------------------------------------------------

const MIME_BY_EXT = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg' };

function mimeForPath(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
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
    const tags = (probe.format && probe.format.tags) || {};
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
  toPublic,
  toQueueEntry,
  sha256File,
  ffprobe,
  classifyM4a,
  probeM4a,
  getById,
  getByYoutubeId,
  getBySha256,
  resolveQueueUrl,
  findUnavailableUrls,
  findBestTextMatch,
  findByTitleArtist,
  list,
  insert,
  remove,
  validateUploadFields,
  validateUploadFileMeta,
  ingestUpload,
  migrateLegacyCache,
  mimeForPath,
};
