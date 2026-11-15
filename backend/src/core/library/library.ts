/**
 * Music library: songs uploaded by the listen-along CLI (AAC in m4a, or Opus
 * in Ogg: `.opus`, stored and served as uploaded), plus the
 * legacy yt-dlp cache migrated in on boot. The server never downloads audio —
 * it only stores, probes and serves what it is given.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dbModule from '../../shared/db.ts';
import type { DbModule } from '../../shared/db.ts';
import { isUuid } from '../../shared/ids.ts';
import type { LibrarySongRow, Queryable } from '../../shared/types.ts';
import * as songMatch from './songMatch.ts';
import * as songReports from './songReports.ts';
import * as songSearch from './songSearch.ts';
import type { ReportView } from './songReports.ts';

// The live module object: tests replace its functions.
const db: DbModule = dbModule;

export { isUuid };

export const SONGS_PATH = process.env.SONGS_PATH || '/data/songs';
// New uploads live in a subfolder so they never mix with the legacy cache files.
export const LIBRARY_DIR = path.join(SONGS_PATH, 'library');
export const UPLOAD_TMP_DIR = path.join(SONGS_PATH, '.upload-tmp');

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_UPLOAD_MIME = new Set([
  'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac',
  'audio/ogg', 'audio/opus', 'audio/x-opus+ogg', 'application/ogg',
  'application/octet-stream',
]);
export type UploadFormat = 'm4a' | 'opus';
// Upload kinds: what ffprobe must find, and how the file is stored and served.
export const UPLOAD_FORMATS: Record<UploadFormat, { ext: string; mime: string }> = {
  m4a: { ext: '.m4a', mime: 'audio/mp4' },
  opus: { ext: '.opus', mime: 'audio/ogg' },
};
const UPLOAD_EXTS = new Set(Object.values(UPLOAD_FORMATS).map((f) => f.ext));

const PUBLIC_COLUMNS = 'id, youtube_id, title, artist, album, duration_sec, source_url, uploaded_by, created_at, sha256, replaced_at, uploaded_by_worker, requested_by, lead_silence_ms, trail_silence_ms';
export const MAX_SOURCE_URL_LENGTH = 2048;

/** The library_songs columns the lists select (PUBLIC_COLUMNS), what toPublic reads. */
export type PublicSongRow = Pick<LibrarySongRow,
  'id' | 'youtube_id' | 'title' | 'artist' | 'album' | 'duration_sec' | 'source_url' | 'uploaded_by' | 'created_at'
  | 'sha256' | 'replaced_at' | 'uploaded_by_worker' | 'requested_by' | 'lead_silence_ms' | 'trail_silence_ms'>;

/** A library song as the API sends it (toPublic), with its open reports once songReports.attachReports ran. */
export interface PublicSong {
  id: string;
  youtube_id: string | null;
  title: string;
  artist: string;
  album: string | null;
  duration_sec: number | null;
  source_url: string | null;
  uploaded_by: string;
  uploaded_by_worker: string | null;
  requested_by: string | null;
  created_at: Date;
  /** the first 16 hex digits of the file's sha256 (the audio url's ?v=) */
  file_version: string | null;
  replaced_at: Date | null;
  lead_silence_ms: number | null;
  trail_silence_ms: number | null;
  reports?: ReportView[];
  report_count?: number;
}

/** The library columns a lean song row is made of (Radio, the artist pages). */
export type LeanSongRow = Pick<LibrarySongRow, 'id' | 'youtube_id' | 'title' | 'artist' | 'duration_sec' | 'sha256'>;

/** A song in a station or on an artist page: lean, no reports or upload details. */
export interface LeanSong {
  id: string;
  youtube_id: string | null;
  title: string;
  artist: string;
  duration_sec: number | null;
  /** the first 16 hex digits of the file's sha256 (the audio url's ?v=) */
  file_version: string | null;
}

/** The queue entry fields of a library song (toQueueEntry). */
export interface QueueEntryFields {
  url: string;
  title: string;
  duration: number;
  thumbnail: string | null;
}

/** What ffprobe answers (the entries ffprobe() asks for). */
export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  tags?: Record<string, unknown>;
  disposition?: { attached_pic?: number };
}
export interface Probe {
  format?: { format_name?: string; duration?: string; tags?: Record<string, unknown> };
  streams?: ProbeStream[];
}

export type ProbeVerdict = { ok: true; duration?: number } | { ok: false; reason: string };
export type UploadVerdict =
  | { ok: true; duration?: number; format: UploadFormat; ext: string; mime: string }
  | { ok: false; reason: string };

/** A multer upload as this module reads it. */
export interface UploadFile {
  path?: string;
  originalname?: string;
  mimetype?: string;
}

/** validateUploadFields: the multipart text fields of an upload, checked. */
export interface UploadFields {
  title: string;
  artist: string;
  album: string | null;
  youtube_id: string | null;
  source_url: string | null;
  duration_sec: number | null;
  request_id: string | null;
  allow_similar: boolean;
}

/**
 * Who uploads or replaces: a CLI token's account (req.apiUser: `id` is the
 * token, `userId` its owner) or a web user ({ id: null, userId, name }), plus
 * the upload records of a worker's job (downloadJobs.uploadContext).
 */
export interface Uploader {
  name: string;
  id?: string | null;
  userId?: string | null;
  workerId?: string | null;
  workerName?: string | null;
  jobId?: string | null;
  requestedByUserId?: string | null;
  requestedBy?: string | null;
}

/** A row to insert (insert()). */
export interface NewSong {
  id?: string;
  youtube_id?: string | null;
  title: string;
  artist: string;
  album?: string | null;
  duration_sec?: number | null;
  file_path: string;
  mime_type?: string;
  size_bytes?: number | null;
  sha256: string;
  source_url?: string | null;
  uploaded_by: string;
  uploaded_by_token?: string | null;
  uploaded_by_user_id?: string | null;
  uploaded_by_worker_id?: string | null;
  uploaded_by_worker?: string | null;
  upload_job_id?: string | null;
  requested_by_user_id?: string | null;
  requested_by?: string | null;
}

/** A `library_song_replacements` row (core/library/schema.ts). */
export interface ReplacementRow {
  /** BIGSERIAL */
  id: string;
  song_id: string;
  /** 'replace' | 'details' */
  kind: string;
  replaced_by_user_id: string | null;
  replaced_by: string | null;
  replaced_by_token: string | null;
  old_youtube_id: string | null;
  old_source_url: string | null;
  old_sha256: string | null;
  old_title: string | null;
  old_artist: string | null;
  old_album: string | null;
  old_duration_sec: number | null;
  new_youtube_id: string | null;
  new_source_url: string | null;
  new_sha256: string | null;
  new_title: string | null;
  new_artist: string | null;
  new_album: string | null;
  new_duration_sec: number | null;
  job_id: string | null;
  worker_name: string | null;
  requested_by: string | null;
  created_at: Date;
}

export function ensureDirs(): void {
  for (const dir of [SONGS_PATH, LIBRARY_DIR, UPLOAD_TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * `p` resolved against `root`, only when the result lies inside `root` (not
 * `root` itself); throws otherwise. ".." segments and absolute paths elsewhere
 * are refused, not followed. Nothing is decoded ("%2F" stays three characters
 * of a file name) and symlinks are not resolved: renaming onto or deleting a
 * link changes the link, never what it points to.
 */
export function pathInside(root: string, p: unknown): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, String(p));
  if (!resolved.startsWith(base + path.sep)) throw new Error(`refused a path outside ${base}`);
  return resolved;
}

/**
 * A path in the songs folder (SONGS_PATH): every path this module renames,
 * stats or deletes goes through here right before the filesystem call. File
 * names are built from a song id (a checked UUID) or come from the database's
 * file_path; neither should ever leave the folder, and this makes sure.
 */
export function songsFile(p: unknown): string {
  return pathInside(SONGS_PATH, p);
}

export function isYoutubeId(value: unknown): value is string {
  return typeof value === 'string' && YOUTUBE_ID_RE.test(value);
}

/**
 * Extract an 11-char YouTube video id from a URL (watch, youtu.be, shorts,
 * music, embed, live) or return the input if it already is a bare id.
 */
export function parseYoutubeId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (isYoutubeId(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\.|^music\./, '');
  let id: string | null | undefined = null;
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

export function youtubeUrl(youtubeId: string | null): string {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

/**
 * Validate/normalise a song's original source link (e.g. the YouTube watch
 * URL it was downloaded from). Only absolute http(s) URLs up to
 * MAX_SOURCE_URL_LENGTH chars are accepted.
 * @returns the normalised URL, or null when invalid
 */
export function normalizeSourceUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > MAX_SOURCE_URL_LENGTH) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  const out = u.toString();
  return out.length <= MAX_SOURCE_URL_LENGTH ? out : null;
}

export function youtubeThumbnail(youtubeId: string | null | undefined): string | null {
  return youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : null;
}

/**
 * The url a library song gets in a playlist's queue. YouTube songs keep their
 * watch URL (so "open on YouTube" and old queue entries keep working);
 * songs without a YouTube id use a `library:<uuid>` pseudo-URL.
 */
export function queueUrlFor(song: Pick<LibrarySongRow, 'id' | 'youtube_id'>): string {
  return song.youtube_id ? youtubeUrl(song.youtube_id) : `library:${song.id}`;
}

/**
 * Whether a playlist's queue (array of entries) already holds this library song:
 * by its queue url (`library:<uuid>` or YouTube watch URL), any other YouTube
 * URL for the same id, or its legacy source_url.
 */
export function isQueued(
  songs: ReadonlyArray<{ url?: string | null } | null | undefined> | null | undefined,
  song: Pick<LibrarySongRow, 'id' | 'youtube_id' | 'source_url'> | null | undefined,
): boolean {
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
export function toPublic(row: PublicSongRow): PublicSong;
export function toPublic(row: PublicSongRow | null | undefined): PublicSong | null;
export function toPublic(row: PublicSongRow | null | undefined): PublicSong | null {
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
    // Silence at the very start / end in ms, null until measured (core/library/silence.ts). Additive.
    lead_silence_ms: row.lead_silence_ms ?? null,
    trail_silence_ms: row.trail_silence_ms ?? null,
  };
}

/** The lean song row of a station and an artist page: no reports or upload details. */
export function toLeanSong(row: LeanSongRow): LeanSong {
  return {
    id: row.id,
    youtube_id: row.youtube_id || null,
    title: row.title,
    artist: row.artist,
    duration_sec: row.duration_sec === null || row.duration_sec === undefined ? null : Number(row.duration_sec),
    file_version: row.sha256 ? String(row.sha256).slice(0, 16) : null,
  };
}

/** Build the queue entry fields for a library song. */
export function toQueueEntry(song: Pick<LibrarySongRow, 'id' | 'youtube_id' | 'title' | 'artist' | 'duration_sec'>): QueueEntryFields {
  return {
    url: queueUrlFor(song),
    title: song.artist && song.artist !== 'Unknown' ? `${song.title} - ${song.artist}` : song.title,
    duration: song.duration_sec || 0,
    thumbnail: youtubeThumbnail(song.youtube_id),
  };
}

/** The artist as a queue row shows it, apart from the combined title. */
export function queueArtist(song: Pick<LibrarySongRow, 'artist'>): string | null {
  return song.artist && song.artist !== 'Unknown' ? song.artist : null;
}

export function sha256File(filePath: string): Promise<string> {
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
export function ffprobe(filePath: string): Promise<Probe | null> {
  return new Promise((resolve) => {
    let proc: ChildProcessWithoutNullStreams;
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
      try { resolve(JSON.parse(stdout) as Probe); } catch { resolve(null); }
    });
  });
}

/**
 * Decide whether ffprobe output describes an m4a: AAC audio in an MP4
 * container. Cover art (an attached-picture video stream) is allowed; real
 * video streams are not.
 */
export function classifyM4a(probe: Probe | null | undefined): ProbeVerdict {
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
  const duration = parseFloat(String(probe.format.duration));
  return { ok: true, duration: Number.isFinite(duration) ? duration : undefined };
}

export async function probeM4a(filePath: string): Promise<ProbeVerdict> {
  return classifyM4a(await ffprobe(filePath));
}

/**
 * Decide whether ffprobe output describes Opus audio in an Ogg container (an
 * `.opus` file, as `la download` makes from YouTube's Opus stream without
 * re-encoding). Cover art (METADATA_BLOCK_PICTURE, which ffprobe shows as an
 * attached picture) is allowed; a real video stream (Theora) is not.
 */
export function classifyOpus(probe: Probe | null | undefined): ProbeVerdict {
  if (!probe || !probe.format) return { ok: false, reason: 'File is not a readable media file' };
  const formatName = String(probe.format.format_name || '');
  if (!/(^|,)ogg(,|$)/.test(formatName)) {
    return { ok: false, reason: `Container must be Ogg (got ${formatName || 'unknown'})` };
  }
  const streams = probe.streams || [];
  const audio = streams.filter((s) => s.codec_type === 'audio');
  if (audio.length === 0) return { ok: false, reason: 'File has no audio stream' };
  if (audio.length > 1) return { ok: false, reason: 'File has more than one audio stream' };
  if (audio[0].codec_name !== 'opus') {
    return { ok: false, reason: `Audio codec must be Opus (got ${audio[0].codec_name || 'unknown'})` };
  }
  const realVideo = streams.filter((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (realVideo.length > 0) return { ok: false, reason: 'File contains a video stream; upload audio only' };
  const duration = parseFloat(String(probe.format.duration));
  return { ok: true, duration: Number.isFinite(duration) ? duration : undefined };
}

/**
 * What an uploaded file is, by its content (never by its name): AAC in MP4
 * (stored as `.m4a`, served as audio/mp4) or Opus in Ogg (`.opus`,
 * audio/ogg). The server never transcodes.
 */
export function classifyUpload(probe: Probe | null | undefined): UploadVerdict {
  if (!probe || !probe.format) return { ok: false, reason: 'File is not a readable media file' };
  const formatName = String(probe.format.format_name || '');
  const isOgg = /(^|,)ogg(,|$)/.test(formatName);
  const isMp4 = /(^|,)(mp4|m4a|mov)(,|$)/.test(formatName);
  if (!isOgg && !isMp4) {
    return { ok: false, reason: `File must be AAC in MP4/M4A or Opus in Ogg (got container ${formatName || 'unknown'})` };
  }
  const format: UploadFormat = isOgg ? 'opus' : 'm4a';
  const r = isOgg ? classifyOpus(probe) : classifyM4a(probe);
  if (!r.ok) return r;
  return { ...r, format, ...UPLOAD_FORMATS[format] };
}

export async function probeUpload(filePath: string): Promise<UploadVerdict> {
  return classifyUpload(await ffprobe(filePath));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getById(id: unknown): Promise<LibrarySongRow | null> {
  if (!isUuid(id)) return null;
  const r = await db.query<LibrarySongRow>('SELECT * FROM library_songs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

export async function getByYoutubeId(youtubeId: unknown): Promise<LibrarySongRow | null> {
  if (!isYoutubeId(youtubeId)) return null;
  const r = await db.query<LibrarySongRow>('SELECT * FROM library_songs WHERE youtube_id = $1', [youtubeId]);
  return r.rows[0] || null;
}

/** Library songs for several YouTube ids at once: Map youtube_id -> row. */
export async function getByYoutubeIds(youtubeIds: readonly unknown[] | null | undefined): Promise<Map<string, LibrarySongRow>> {
  const ids = [...new Set((youtubeIds || []).filter(isYoutubeId))];
  if (!ids.length) return new Map();
  const r = await db.query<LibrarySongRow>('SELECT * FROM library_songs WHERE youtube_id = ANY($1::text[])', [ids]);
  // The query selected by youtube_id: every row has one.
  return new Map(r.rows.map((row) => [row.youtube_id!, row]));
}

export async function getBySha256(sha: string): Promise<LibrarySongRow | null> {
  const r = await db.query<LibrarySongRow>('SELECT * FROM library_songs WHERE sha256 = $1', [sha]);
  return r.rows[0] || null;
}

/**
 * Resolve whatever a queue entry carries as `url` to a library song:
 * `library:<uuid>`, a YouTube URL/id, or a legacy cache URL (source_url).
 */
export async function resolveQueueUrl(url: unknown): Promise<LibrarySongRow | null> {
  if (typeof url !== 'string' || !url) return null;
  if (url.startsWith('library:')) return getById(url.slice('library:'.length));
  const ytId = parseYoutubeId(url);
  if (ytId) {
    const song = await getByYoutubeId(ytId);
    if (song) return song;
  }
  const r = await db.query<LibrarySongRow>('SELECT * FROM library_songs WHERE source_url = $1 LIMIT 1', [url]);
  if (r.rows[0]) return r.rows[0];
  return resolveReplacedUrl(url, ytId);
}

/**
 * A url that pointed at a song before its audio was replaced (its old
 * YouTube id / source link) still resolves to that song. Queue entries are
 * rewritten on replace; this covers anything that kept the old url.
 */
async function resolveReplacedUrl(url: string, ytId: string | null): Promise<LibrarySongRow | null> {
  const r = await db.query<LibrarySongRow>(
    `SELECT s.* FROM library_song_replacements r JOIN library_songs s ON s.id = r.song_id
     WHERE ($1::text IS NOT NULL AND r.old_youtube_id = $1) OR r.old_source_url = $2
     ORDER BY r.created_at DESC LIMIT 1`,
    [ytId || null, url]
  ).catch(() => ({ rows: [] as LibrarySongRow[] }));
  return r.rows[0] || null;
}

/** Return the subset of urls that do NOT resolve to a library song. */
export async function findUnavailableUrls(urls: readonly unknown[]): Promise<string[]> {
  const unique = [...new Set(urls.filter((u): u is string => typeof u === 'string' && !!u))];
  if (!unique.length) return [];
  const ids: string[] = [];
  const ytIds: string[] = [];
  for (const url of unique) {
    if (url.startsWith('library:')) { const id = url.slice(8); if (isUuid(id)) ids.push(id); }
    const yt = parseYoutubeId(url);
    if (yt) ytIds.push(yt);
  }
  const r = await db.query<{ id: string; youtube_id: string | null; source_url: string | null }>(
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

// Relevance search: candidates fetched before ranking (songSearch.rankSongs).
// Exact and prefix matches are ordered first in SQL so they are never cut off.
const RELEVANCE_CANDIDATES = 400;

/** A page of library songs (list / searchRelevant). */
export interface SongPage {
  songs: PublicSong[];
  total: number;
}

/**
 * The global search (sort=relevance, opt-in): every word of q somewhere in
 * title, artist or album, folded (case, Turkish i/ı/İ, accents: songSearch.fold),
 * best matches first (songSearch.rankSongs). offset + limit stay within
 * RELEVANCE_CANDIDATES. An empty query lists nothing.
 */
async function searchRelevant({ q = '', limit = 50, offset = 0 }: { q?: string; limit?: number; offset?: number } = {}): Promise<SongPage> {
  const words = songSearch.queryWords(q);
  if (!words.length) return { songs: [], total: 0 };
  const params: unknown[] = [songSearch.FOLD_FROM, songSearch.FOLD_TO];
  const f = (expr: string) => songSearch.foldSql(expr, '$1', '$2');
  const where = words.map((w) => {
    params.push(`%${w.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    return `${f("title || ' ' || artist || ' ' || COALESCE(album, '')")} LIKE $${params.length}`;
  });
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM library_songs ${whereSql}`, params);
  const phrase = words.join(' ');
  params.push(phrase, `${phrase.replace(/[\\%_]/g, (c) => '\\' + c)}%`, RELEVANCE_CANDIDATES);
  const [exact, prefix, cap] = [params.length - 2, params.length - 1, params.length];
  const rows = await db.query<PublicSongRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM library_songs ${whereSql}
     ORDER BY CASE WHEN ${f('title')} = $${exact} OR ${f('artist')} = $${exact} THEN 0
                   WHEN ${f('title')} LIKE $${prefix} OR ${f('artist')} LIKE $${prefix} THEN 1
                   ELSE 2 END, lower(title), id
     LIMIT $${cap}`,
    params
  );
  const ranked = songSearch.rankSongs(q, rows.rows);
  return { songs: ranked.slice(offset, offset + limit).map((row) => toPublic(row)), total: total.rows[0].n };
}

export interface ListOptions {
  q?: string;
  limit?: number;
  offset?: number;
  youtubeId?: string | null;
  /** 'recent' (default) | 'title' | 'artist' | 'relevance' */
  sort?: string;
  reported?: boolean;
}

/**
 * Search/list library songs. Every whitespace-separated word of q must appear
 * (case-insensitive) in title, artist or album. sort=relevance is the global
 * search's own order (searchRelevant).
 */
export async function list({ q = '', limit = 100, offset = 0, youtubeId = null, sort = 'recent', reported = false }: ListOptions = {}): Promise<SongPage> {
  if (sort === 'relevance' && !youtubeId && !reported) {
    return searchRelevant({ q, limit: Math.min(limit, RELEVANCE_CANDIDATES), offset: Math.min(offset, RELEVANCE_CANDIDATES) });
  }
  const where: string[] = [];
  const params: unknown[] = [];
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
  const orders: Record<string, string> = {
    recent: 'created_at DESC, id',
    title: 'lower(title), lower(artist), id',
    artist: 'lower(artist), lower(title), id',
  };
  const orderSql = orders[sort] || 'created_at DESC, id';
  // The reported list, "recent": the most recently reported first.
  const orderFinal = reported && (sort === 'recent' || !sort)
    ? '(SELECT max(rr.updated_at) FROM library_song_reports rr WHERE rr.song_id = library_songs.id AND rr.resolved_at IS NULL) DESC NULLS LAST, id'
    : orderSql;

  const total = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM library_songs ${whereSql}`, params);
  params.push(limit, offset);
  const rows = await db.query<PublicSongRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM library_songs ${whereSql} ORDER BY ${orderFinal} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { songs: rows.rows.map((row) => toPublic(row)), total: total.rows[0].n };
}

/** Best library match for free text (used when YouTube search is unavailable). */
export async function findBestTextMatch(text: string): Promise<LibrarySongRow | null> {
  const { songs } = await list({ q: text, limit: 1, sort: 'title' });
  return songs[0] ? getById(songs[0].id) : null;
}

/** Exact (case-insensitive) title + artist match, e.g. for Spotify links. */
export async function findByTitleArtist(title: string | null | undefined, artist: string | null | undefined): Promise<LibrarySongRow | null> {
  if (!title || !artist) return null;
  const r = await db.query<LibrarySongRow>(
    'SELECT * FROM library_songs WHERE lower(title) = lower($1) AND lower(artist) = lower($2) LIMIT 1',
    [title, artist]
  );
  return r.rows[0] || null;
}

export async function insert(song: NewSong, client: Queryable = db): Promise<LibrarySongRow> {
  const r = await client.query<LibrarySongRow>(
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
export async function remove(id: unknown): Promise<LibrarySongRow | null> {
  const song = await getById(id);
  if (!song) return null;
  await db.query('DELETE FROM library_songs WHERE id = $1', [id]);
  try { fs.unlinkSync(songsFile(song.file_path)); } catch {}
  return song;
}

// ---------------------------------------------------------------------------
// Upload ingest
// ---------------------------------------------------------------------------

export class UploadError extends Error {
  /** HTTP status */
  status: number;
  /** the existing song a 409 collided with */
  song: LibrarySongRow | null | undefined;
  /** machine-readable reason, e.g. duplicate_hash */
  code?: string;
  /** set by the upload route: the job context the upload carried */
  uploadContext?: unknown;

  constructor(status: number, message: string, song?: LibrarySongRow | null, code?: string) {
    super(message);
    this.status = status;
    this.song = song;
    if (code) this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

type DuplicateKind = 'youtube_id' | 'sha256' | 'metadata';

/** Reasons a song counts as already in the library, strongest first. */
export const DUPLICATE_REASONS: Record<DuplicateKind, { code: string; exact: boolean; message: string }> = {
  youtube_id: { code: 'already_in_library', exact: true, message: 'A song with this youtube_id is already in the library' },
  sha256: { code: 'duplicate_hash', exact: true, message: 'This exact file is already in the library' },
  metadata: { code: 'duplicate_metadata', exact: false, message: 'A song with the same artist, title and duration (±3s) is already in the library' },
};

/** A song already in the library that matches (findDuplicates). */
export interface DuplicateMatch {
  /** already_in_library | duplicate_hash | duplicate_metadata */
  reason: string;
  exact: boolean;
  message: string;
  song: LibrarySongRow;
}

function duplicateMatch(kind: DuplicateKind, song: LibrarySongRow): DuplicateMatch {
  const r = DUPLICATE_REASONS[kind];
  return { reason: r.code, exact: r.exact, message: r.message, song };
}

export function normalizeSha256(value: unknown): string | null {
  const s = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

/** What findDuplicates looks for; missing signals are skipped. */
export interface DuplicateQuery {
  youtube_id?: unknown;
  sha256?: unknown;
  title?: unknown;
  artist?: unknown;
  duration_sec?: unknown;
  excludeId?: string | null;
  /** false: no probable (metadata) matches */
  metadata?: boolean;
}

/**
 * Songs already in the library that match what is about to be uploaded, by
 * youtube_id, file hash and (probable) normalized artist + title with a
 * duration within ±3s. Missing signals are skipped.
 * @param client db or a transaction client
 * @returns strongest first, one entry per song
 */
export async function findDuplicates(q: DuplicateQuery = {}, client: Queryable = db): Promise<DuplicateMatch[]> {
  const matches: DuplicateMatch[] = [];
  const seen = new Set<string>();
  const push = (kind: DuplicateKind, row: LibrarySongRow | undefined) => {
    if (!row || seen.has(row.id) || (q.excludeId && row.id === q.excludeId)) return;
    seen.add(row.id);
    matches.push(duplicateMatch(kind, row));
  };
  const ytId = q.youtube_id ? parseYoutubeId(String(q.youtube_id)) : null;
  if (ytId) {
    const r = await client.query<LibrarySongRow>('SELECT * FROM library_songs WHERE youtube_id = $1', [ytId]);
    push('youtube_id', r.rows[0]);
  }
  const sha = normalizeSha256(q.sha256);
  if (sha) {
    const r = await client.query<LibrarySongRow>('SELECT * FROM library_songs WHERE sha256 = $1', [sha]);
    push('sha256', r.rows[0]);
  }
  if (q.metadata !== false) {
    const key = songMatch.metaKey(q.title, q.artist);
    const duration = Number(q.duration_sec);
    if (key && Number.isFinite(duration) && duration > 0) {
      const r = await client.query<LibrarySongRow>(
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
function metaLockKey(key: string): number {
  return crypto.createHash('sha256').update(`la-meta:${key}`).digest().readInt32BE(0);
}

export function cleanText(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Validate the multipart text fields of an upload.
 * source_url is optional (http(s), <= 2048 chars); when absent it is derived
 * from youtube_id.
 * @throws {UploadError} 400 on invalid input
 */
export function validateUploadFields(body: Record<string, unknown> = {}): UploadFields {
  const title = cleanText(body.title, 300);
  const artist = cleanText(body.artist, 300);
  const album = cleanText(body.album, 300) || null;
  if (!title) throw new UploadError(400, 'title is required');
  if (!artist) throw new UploadError(400, 'artist is required');

  let youtube_id: string | null = null;
  if (body.youtube_id !== undefined && String(body.youtube_id).trim() !== '') {
    youtube_id = parseYoutubeId(String(body.youtube_id));
    if (!youtube_id) throw new UploadError(400, 'youtube_id must be an 11-character YouTube video id');
  }

  let source_url: string | null = null;
  if (body.source_url !== undefined && body.source_url !== null && String(body.source_url).trim() !== '') {
    source_url = normalizeSourceUrl(String(body.source_url));
    if (!source_url) {
      throw new UploadError(400, `source_url must be an http(s) URL of at most ${MAX_SOURCE_URL_LENGTH} characters`);
    }
  } else if (youtube_id) {
    source_url = youtubeUrl(youtube_id);
  }

  let duration_sec: number | null = null;
  if (body.duration_sec !== undefined && String(body.duration_sec).trim() !== '') {
    duration_sec = Number(body.duration_sec);
    if (!Number.isFinite(duration_sec) || duration_sec < 0 || duration_sec > 24 * 3600) {
      throw new UploadError(400, 'duration_sec must be a non-negative number of seconds');
    }
  }

  let request_id: string | null = null;
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
export function uploadTmpPath(file: UploadFile | null | undefined): string {
  const root = path.resolve(UPLOAD_TMP_DIR);
  const resolved = path.resolve(root, path.basename(String((file && file.path) || '')));
  if (!resolved.startsWith(root + path.sep)) throw new UploadError(400, 'Bad upload temp path');
  return resolved;
}

/** Best-effort delete of a multer upload's temp file. */
export function removeUploadTmp(file: UploadFile | null | undefined): void {
  try { fs.rmSync(uploadTmpPath(file), { force: true }); } catch {}
}

export function validateUploadFileMeta(file: UploadFile | null | undefined): void {
  if (!file) throw new UploadError(400, 'file is required (multipart field "file")');
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!UPLOAD_EXTS.has(ext)) throw new UploadError(400, 'Only .m4a (AAC) and .opus (Opus in Ogg) files are accepted');
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime && !ALLOWED_UPLOAD_MIME.has(mime)) {
    throw new UploadError(400, `Unsupported content type ${mime}; expected audio/mp4 or audio/ogg`);
  }
}

/**
 * Ingest an uploaded temp file into the library. Always consumes (moves or
 * deletes) the temp file.
 * @param file multer file
 * @param fields validated fields (validateUploadFields)
 * @param uploader req.apiUser: name is credited in uploaded_by, id is the
 *   token, userId its owner (or null)
 * @returns inserted DB row
 * @throws {UploadError} 400 invalid file, 409 duplicate (err.song set)
 */
export async function ingestUpload(file: UploadFile, fields: UploadFields, uploader: Uploader): Promise<LibrarySongRow> {
  const tmpPath = uploadTmpPath(file);
  let finalPath: string | null = null;
  try {
    const probe = await probeUpload(tmpPath);
    if (!probe.ok) throw new UploadError(400, probe.reason);

    const sha = await sha256File(tmpPath);
    const duration = fields.duration_sec ?? probe.duration ?? null;
    const query: DuplicateQuery = {
      youtube_id: fields.youtube_id, sha256: sha, title: fields.title, artist: fields.artist,
      duration_sec: duration, metadata: !fields.allow_similar,
    };
    const rejectDuplicate = (matches: DuplicateMatch[]) => {
      const m = matches[0];
      if (m) throw new UploadError(409, m.message, m.song, m.reason);
    };
    // Cheap check before touching the library dir; repeated under the lock.
    rejectDuplicate(await findDuplicates(query));

    ensureDirs();
    const id = crypto.randomUUID();
    finalPath = songsFile(path.join(LIBRARY_DIR, `${id}${probe.ext}`));
    fs.renameSync(tmpPath, finalPath);
    const size = fs.statSync(finalPath).size;
    const row: NewSong = {
      id,
      youtube_id: fields.youtube_id,
      title: fields.title,
      artist: fields.artist,
      album: fields.album,
      duration_sec: duration,
      file_path: finalPath,
      mime_type: probe.mime,
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
      if ((err as { code?: string }).code === '23505') {
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

/** What replaceSong / updateDetails answer: the new row and the one before. */
export interface SongChange {
  song: LibrarySongRow;
  previous: LibrarySongRow;
}

/**
 * Replace the audio file and metadata (title, artist, album, youtube_id,
 * source_url, duration) of an existing library song, keeping its id — every
 * playlist that holds it plays the new file. Writes an audit row to
 * library_song_replacements. The old file is deleted only after the new one
 * is in place and the row is committed. Always consumes the temp file.
 *
 * @param id library song id
 * @param file multer file
 * @param fields validated fields (validateUploadFields)
 * @param actor who replaces (req.apiUser for a token; { name, userId } for a web user)
 * @returns new and old rows, and how many open "needs replacement" reports it resolved
 * @throws {UploadError} 400 invalid file, 404 unknown song, 409 the file /
 *   youtube_id belongs to another song (err.song set), or it is the same file
 */
export async function replaceSong(id: string, file: UploadFile, fields: UploadFields, actor: Uploader): Promise<SongChange & { resolvedReports: number }> {
  const tmpPath = uploadTmpPath(file);
  let newPath: string | null = null;
  try {
    if (!isUuid(id) || !(await getById(id))) throw new UploadError(404, 'Song not found', null, 'not_found');
    const probe = await probeUpload(tmpPath);
    if (!probe.ok) throw new UploadError(400, probe.reason);
    const sha = await sha256File(tmpPath);

    ensureDirs();
    // A new file name: the old file stays untouched until the row points here.
    // The format may change (an m4a song replaced by an Opus file, or back).
    newPath = songsFile(path.join(LIBRARY_DIR, `${id}-${crypto.randomBytes(4).toString('hex')}${probe.ext}`));
    fs.renameSync(tmpPath, newPath);
    const size = fs.statSync(newPath).size;

    const client = await db.getClient();
    let previous: LibrarySongRow | undefined;
    let updated: LibrarySongRow;
    let resolvedReports = 0;
    try {
      await client.query('BEGIN');
      const cur = await client.query<LibrarySongRow>('SELECT * FROM library_songs WHERE id = $1 FOR UPDATE', [id]);
      previous = cur.rows[0];
      if (!previous) throw new UploadError(404, 'Song not found', null, 'not_found');
      if (previous.sha256 === sha) throw new UploadError(409, 'This song already has exactly this file', previous, 'same_file');
      const clash = (await findDuplicates({ youtube_id: fields.youtube_id, sha256: sha, metadata: false, excludeId: id }, client))[0];
      if (clash) {
        throw new UploadError(409, `${clash.message} as another song (${clash.song.id}); replace or delete that one instead`, clash.song, clash.reason);
      }
      const duration = fields.duration_sec ?? probe.duration ?? null;
      const sourceUrl = fields.source_url || (fields.youtube_id ? youtubeUrl(fields.youtube_id) : null);
      const r = await client.query<LibrarySongRow>(
        `UPDATE library_songs SET
           youtube_id = $2, title = $3, artist = $4, album = $5, duration_sec = $6,
           file_path = $7, mime_type = $13, size_bytes = $8, sha256 = $9, source_url = $10,
           meta_key = $11, meta_key_version = $12, replaced_at = now()
         WHERE id = $1 RETURNING *`,
        [id, fields.youtube_id || null, fields.title, fields.artist, fields.album || null, duration,
          newPath, size, sha, sourceUrl, songMatch.metaKey(fields.title, fields.artist), songMatch.META_KEY_VERSION, probe.mime]
      );
      updated = r.rows[0];
      await client.query(
        `INSERT INTO library_song_replacements
           (song_id, replaced_by_user_id, replaced_by, replaced_by_token,
            old_youtube_id, old_source_url, old_sha256, old_title, old_artist, old_album, old_duration_sec,
            new_youtube_id, new_source_url, new_sha256, new_title, new_artist, new_album, new_duration_sec,
            job_id, worker_name, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [id, actor.userId || null, actor.name || null, actor.id || null,
          previous.youtube_id, previous.source_url, previous.sha256, previous.title, previous.artist, previous.album, previous.duration_sec,
          updated.youtube_id, updated.source_url, updated.sha256, updated.title, updated.artist, updated.album, updated.duration_sec,
          actor.jobId || null, actor.workerName || null, actor.requestedBy || null]
      );
      // The song is fixed: every open "needs replacement" report is resolved.
      resolvedReports = await songReports.resolveForSong(id, { resolution: 'replaced', userId: actor.userId, name: actor.name }, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if ((err as { code?: string }).code === '23505') {
        const dup = (await findDuplicates({ youtube_id: fields.youtube_id, sha256: sha, metadata: false, excludeId: id }))[0];
        throw new UploadError(409, dup ? `${dup.message} as another song` : 'Conflicts with another song', dup && dup.song, dup ? dup.reason : 'conflict');
      }
      throw err;
    } finally {
      client.release();
    }
    newPath = null; // owned by the row now
    if (previous.file_path && path.resolve(previous.file_path) !== path.resolve(updated.file_path)) {
      try { fs.unlinkSync(songsFile(previous.file_path)); } catch {}
    }
    return { song: updated, previous, resolvedReports };
  } finally {
    if (newPath) { try { fs.unlinkSync(newPath); } catch {} }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
}

/** PATCH /api/library/:id: what is left out stays; an empty album clears it. */
export interface DetailsPatch {
  title?: unknown;
  artist?: unknown;
  album?: unknown;
}

/**
 * Title, artist and album only: the audio, its id and its reports stay. Audited
 * in library_song_replacements (kind 'details', same sha). Like a replace, a
 * probable (metadata) duplicate is not refused: only uploads are, and fixing a
 * name must stay possible. An active replace job keeps the newer details.
 *
 * @throws {UploadError} 400 bad or unchanged values, 404 unknown song
 */
export async function updateDetails(id: string, patch: DetailsPatch, actor: Uploader): Promise<SongChange> {
  if (!isUuid(id)) throw new UploadError(404, 'Song not found', null, 'not_found');
  const given = (k: keyof DetailsPatch) => patch[k] !== undefined && patch[k] !== null;
  const title = given('title') ? cleanText(patch.title, 300) : null;
  const artist = given('artist') ? cleanText(patch.artist, 300) : null;
  if (given('title') && !title) throw new UploadError(400, 'title is required', null, 'bad_details');
  if (given('artist') && !artist) throw new UploadError(400, 'artist is required', null, 'bad_details');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const cur = await client.query<LibrarySongRow>('SELECT * FROM library_songs WHERE id = $1 FOR UPDATE', [id]);
    const previous = cur.rows[0];
    if (!previous) throw new UploadError(404, 'Song not found', null, 'not_found');
    const next = {
      title: title ?? previous.title,
      artist: artist ?? previous.artist,
      album: patch.album !== undefined ? (cleanText(patch.album, 300) || null) : (previous.album || null),
    };
    if (next.title === previous.title && next.artist === previous.artist && next.album === (previous.album || null)) {
      throw new UploadError(400, 'Nothing to change', null, 'nothing_changed');
    }
    const r = await client.query<LibrarySongRow>(
      `UPDATE library_songs SET title = $2, artist = $3, album = $4, meta_key = $5, meta_key_version = $6
       WHERE id = $1 RETURNING *`,
      [id, next.title, next.artist, next.album, songMatch.metaKey(next.title, next.artist), songMatch.META_KEY_VERSION]
    );
    const song = r.rows[0];
    await client.query(
      `INSERT INTO library_song_replacements
         (song_id, kind, replaced_by_user_id, replaced_by, replaced_by_token,
          old_youtube_id, old_source_url, old_sha256, old_title, old_artist, old_album, old_duration_sec,
          new_youtube_id, new_source_url, new_sha256, new_title, new_artist, new_album, new_duration_sec)
       VALUES ($1, 'details', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $5, $6, $7, $12, $13, $14, $11)`,
      [id, actor.userId || null, actor.name || null, actor.id || null,
        previous.youtube_id, previous.source_url, previous.sha256, previous.title, previous.artist, previous.album, previous.duration_sec,
        next.title, next.artist, next.album]
    );
    await client.query(
      `UPDATE download_jobs SET replace_title = $2, replace_artist = $3, replace_album = $4, updated_at = now()
       WHERE replace_song_id = $1 AND status IN ('queued', 'assigned')`,
      [id, next.title, next.artist, next.album]
    );
    await client.query('COMMIT');
    return { song, previous };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Replacement history of a song, newest first. */
export async function listReplacements(songId: unknown, limit = 20): Promise<ReplacementRow[]> {
  if (!isUuid(songId)) return [];
  const r = await db.query<ReplacementRow>(
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
 * @returns rows updated
 */
export async function backfillMetaKeys({ batchSize = 200, pauseMs = 50 }: { batchSize?: number; pauseMs?: number } = {}): Promise<number> {
  if (!db.isAvailable()) return 0;
  let updated = 0;
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const r = await db.query<{ id: string; title: string; artist: string }>(
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
      // An UPDATE always reports its row count.
      updated += res.rowCount!;
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

const MIME_BY_EXT: Record<string, string> = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg' };

export function mimeForPath(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Title/artist/album tags from a probe, keys lower-cased. MP3/MP4 keep them
 * on the container, but Ogg/Opus keeps them on the audio stream and Matroska
 * /WebM writes them in upper case (ARTIST), so look in both places.
 */
function probeTags(probe: Probe | null): Record<string, string> {
  const tags: Record<string, string> = {};
  const add = (src: Record<string, unknown> | false | null | undefined) => {
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

function isAudioProbe(probe: Probe | null): boolean {
  return !!(probe && (probe.streams || []).some((s) => s.codec_type === 'audio'));
}

/** What the legacy cache knows of a file (migrateLegacyCache). */
interface LegacyMeta {
  title?: string | null;
  artist?: string;
  duration?: number;
  youtube_id?: string | null;
  source_url?: string;
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
 */
export async function migrateLegacyCache({ songsPath = SONGS_PATH }: { songsPath?: string } = {}): Promise<{ registered: number; skipped: number }> {
  if (!db.isAvailable()) return { registered: 0, skipped: 0 };
  let registered = 0;
  let skipped = 0;

  const known = await db.query<{ file_path: string }>('SELECT file_path FROM library_songs');
  const knownPaths = new Set(known.rows.map((r) => r.file_path));

  const register = async (filePath: string, meta: LegacyMeta) => {
    if (knownPaths.has(filePath)) { skipped++; return; }
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { skipped++; return; }
    if (!stat.isFile() || stat.size < 10240) { skipped++; return; }
    const probe = await ffprobe(filePath);
    if (!isAudioProbe(probe)) { skipped++; return; }
    const sha = await sha256File(filePath);
    if (await getBySha256(sha)) { skipped++; knownPaths.add(filePath); return; }
    let youtubeId = meta.youtube_id || null;
    if (youtubeId && await getByYoutubeId(youtubeId)) youtubeId = null; // keep file, drop the clashing id
    const tags = probeTags(probe);
    // isAudioProbe said there is a probe.
    const probeDuration = parseFloat(String(probe!.format && probe!.format.duration));
    try {
      await insert({
        youtube_id: youtubeId,
        title: cleanText(meta.title || tags.title || path.basename(filePath, path.extname(filePath)), 300) || 'Unknown',
        artist: cleanText(meta.artist || tags.artist, 300) || 'Unknown',
        album: cleanText(tags.album, 300) || null,
        duration_sec: (meta.duration ?? 0) > 0 ? meta.duration : (Number.isFinite(probeDuration) ? probeDuration : null),
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
      if ((err as { code?: string }).code === '23505') { skipped++; return; }
      throw err;
    }
  };

  // 1. legacy songs table (may not exist on a fresh install that never had it)
  let legacyRows: Array<{ url: string; title: string | null; duration: number | null; file_path: string }> = [];
  try {
    const r = await db.query<{ url: string; title: string | null; duration: number | null; file_path: string }>(
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
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(songsPath, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!MIME_BY_EXT[path.extname(entry.name).toLowerCase()]) continue;
    await register(path.join(songsPath, entry.name), {});
  }

  if (registered > 0) console.log(`[library] Migrated ${registered} legacy cached song(s) into the library (${skipped} skipped)`);
  return { registered, skipped };
}
