/**
 * YouTube *metadata* helpers. The server no longer downloads or streams audio
 * from YouTube (its IP is blocked; the listen-along CLI downloads on a home
 * machine and uploads to the library). What is left here only resolves what a
 * user typed into a YouTube video id + title, so that a library lookup or a song
 * request can be made:
 *   - searchYoutube:      `yt-dlp --flat-playlist ytsearch1:` (search results
 *                         page only, no player API, so no PO token needed);
 *                         searchYoutubeMany is the same for the first few hits
 *   - getPlaylistEntries: `yt-dlp --flat-playlist` (playlist page only)
 *   - getOembed:          YouTube's public oEmbed endpoint (title/channel for an id)
 *   - previewVideo:       oEmbed + a flat search for the id: title and duration
 * All of these are best-effort; callers must cope with failure.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** An Error with yt-dlp's reason (parseError). */
export type YtdlpError = Error & { code?: string };

/** A playlist entry (getPlaylistEntries). */
export interface PlaylistEntry {
  id: string;
  url: string;
  title: string;
  duration: number;
  channel: string | null;
  thumbnail: string | null;
}

/** getPlaylistEntries' answer: the entries, with the playlist's name riding along. */
export type PlaylistEntries = PlaylistEntry[] & { title?: string | null };

/** A search hit (searchYoutubeMany). */
export interface SearchHit {
  id: string;
  url: string;
  title: string | null;
  duration: number;
  channel: string | null;
}

/** What yt-dlp's -J prints, as far as it is read here. */
interface YtdlpEntry {
  id?: string;
  url?: string;
  title?: string;
  duration?: number;
  channel?: string;
  uploader?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string }>;
}
interface YtdlpJson {
  title?: unknown;
  entries?: Array<YtdlpEntry | null>;
}

/**
 * Strip list/index params from a YouTube URL so yt-dlp fetches only the single
 * video, never an entire list. Search terms and non-URL targets pass through
 * unchanged.
 * @param target URL or search target
 * @returns target with list-expanding params removed
 */
export function stripListParam<T>(target: T): T | string {
  if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) return target;
  try {
    const u = new URL(target);
    ['list', 'index', 'start_radio', 'pp'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return target;
  }
}

/**
 * If a URL points at a real YouTube playlist the user wants to import, return
 * its list id; otherwise null. Auto-generated radio/mix lists (list=RD…) are
 * NOT real playlists — a watch URL often carries one incidentally — so those
 * return null and are handled as a single video.
 * @param target URL or search target
 * @returns playlist id, or null if not an importable playlist
 */
export function parsePlaylistId(target: unknown): string | null {
  if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) return null;
  let u: URL;
  try { u = new URL(target); } catch { return null; }
  if (!/(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/i.test(u.hostname)) return null;
  const list = u.searchParams.get('list');
  if (!list || /^RD/i.test(list)) return null; // RD* = radio/mix, not a playlist
  return list;
}

/**
 * Enumerate a YouTube playlist's entries without downloading them
 * (--flat-playlist is fast: it lists ids/titles, not full per-video metadata).
 * Unavailable entries (deleted/private) are filtered out.
 * @param url playlist or watch?…&list= URL
 * @returns the entries, with .title = the playlist's name (or null)
 */
export function getPlaylistEntries(url: string): Promise<PlaylistEntries> {
  return new Promise((resolve, reject) => {
    const args = [
      '--flat-playlist',
      '-J',                    // dump the whole playlist as one JSON object
      url,
    ];
    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    const watchdog = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Playlist read timed out after 60s'));
    }, 60000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(watchdog);
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(watchdog);
      if (code !== 0) return reject(parseError(stderr, code));
      let data: YtdlpJson;
      try {
        data = JSON.parse(stdout);
      } catch (err) {
        return reject(new Error(`Failed to parse playlist: ${(err as Error).message}`));
      }
      const entries: PlaylistEntries = (data.entries || [])
        .filter((e): e is YtdlpEntry & { id: string; title: string } => !!e && !!e.id && !!e.title &&
          e.title !== '[Deleted video]' && e.title !== '[Private video]' &&
          e.title !== '[Unavailable video]')
        .map((e) => ({
          id: e.id,
          url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
          title: e.title,
          duration: e.duration || 0,
          channel: e.channel || e.uploader || null,
          thumbnail: (e.thumbnails && e.thumbnails.length && e.thumbnails[e.thumbnails.length - 1].url) || e.thumbnail || null,
        }));
      // The playlist's own name rides along on the array (callers that slice
      // or map it simply lose it).
      entries.title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
      resolve(entries);
    });
  });
}

/**
 * Parse yt-dlp error output into a user-friendly error
 * @param stderr Error output from yt-dlp
 * @param code Exit code
 * @returns Parsed error with appropriate message
 */
export function parseError(stderr: string, code: number | null): YtdlpError {
  const lowerErr = stderr.toLowerCase();

  if (lowerErr.includes('drm')) {
    const err: YtdlpError = new Error("This track is DRM-protected and can't be played");
    err.code = 'DRM_PROTECTED';
    return err;
  }

  if (lowerErr.includes('private video')) {
    const err: YtdlpError = new Error('This video is private');
    err.code = 'VIDEO_PRIVATE';
    return err;
  }

  // "Sign in to confirm you're not a bot" is YouTube's bot/IP challenge — it is
  // NOT an age restriction (it just contains the words "sign in"). It means this
  // server's IP is blocked; fix is cookies / a PO token / a proxy. Check this
  // BEFORE the age/sign-in cases so it isn't mislabeled as age-restricted.
  if (lowerErr.includes('not a bot') || lowerErr.includes('confirm you’re not a bot')) {
    const err: YtdlpError = new Error("YouTube is blocking this server's IP (bot check)");
    err.code = 'BOT_CHECK';
    return err;
  }

  if (lowerErr.includes('confirm your age') || lowerErr.includes('age-restricted') ||
      lowerErr.includes('age restricted') || lowerErr.includes('inappropriate for some')) {
    const err: YtdlpError = new Error('This video is age-restricted (needs a verified-account cookie)');
    err.code = 'AGE_RESTRICTED';
    return err;
  }

  if (lowerErr.includes('sign in') || lowerErr.includes('members-only') ||
      lowerErr.includes('join this channel') || lowerErr.includes('login required')) {
    const err: YtdlpError = new Error('Video requires sign-in (login-only or members-only)');
    err.code = 'VIDEO_RESTRICTED';
    return err;
  }

  // Check region block before generic unavailable (more specific match first)
  if (lowerErr.includes('blocked') || lowerErr.includes('not available in your country')) {
    const err: YtdlpError = new Error('Video is blocked in this region');
    err.code = 'VIDEO_BLOCKED';
    return err;
  }

  if (lowerErr.includes('video unavailable') || lowerErr.includes('not available')) {
    const err: YtdlpError = new Error('Video not available');
    err.code = 'VIDEO_UNAVAILABLE';
    return err;
  }

  if (lowerErr.includes('no video formats') || lowerErr.includes('no suitable format')) {
    const err: YtdlpError = new Error('No audio format available');
    err.code = 'NO_FORMAT';
    return err;
  }

  if (lowerErr.includes('unable to extract') || lowerErr.includes('no results') || lowerErr.includes('http error 404')) {
    const err: YtdlpError = new Error('Video not found');
    err.code = 'NOT_FOUND';
    return err;
  }

  // Generic error
  const err: YtdlpError = new Error(`yt-dlp error (code ${code}): ${stderr.slice(0, 200)}`);
  err.code = 'YTDLP_ERROR';
  return err;
}

/**
 * Check if yt-dlp is available
 */
export function checkAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', ['--version']);
    // Short watchdog so a hung yt-dlp can't block the caller indefinitely.
    const watchdog = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(false);
    }, 20000);
    proc.on('close', (code) => { clearTimeout(watchdog); resolve(code === 0); });
    proc.on('error', () => { clearTimeout(watchdog); resolve(false); });
  });
}

/**
 * checkAvailable(), remembered for `maxAgeMs` (default 10 min). GET /health
 * (Docker healthcheck every 30s, uptime monitors) used to spawn a yt-dlp
 * process per request; under load that made a liveness probe take seconds.
 * The first call (and any call after the cache expires) still waits for one
 * check; concurrent callers share it.
 */
export function createAvailabilityCache(
  { check = checkAvailable, maxAgeMs = 10 * 60 * 1000, now = Date.now }:
  { check?: () => Promise<boolean> | boolean; maxAgeMs?: number; now?: () => number } = {},
): () => Promise<boolean> {
  let value: boolean | null = null;
  let at = 0;
  let pending: Promise<boolean> | null = null;
  function refresh(): Promise<boolean> {
    if (!pending) {
      pending = Promise.resolve().then(check).catch(() => false).then((ok) => {
        value = !!ok;
        at = now();
        pending = null;
        return value;
      });
    }
    return pending;
  }
  return function cachedAvailable() {
    if (value !== null && now() - at < maxAgeMs) return Promise.resolve(value);
    // Stale: answer with the last known value and refresh in the background.
    if (value !== null) { refresh(); return Promise.resolve(value); }
    return refresh();
  };
}

export const availableCached = createAvailabilityCache();

/**
 * Run yt-dlp with args and return parsed JSON from stdout.
 */
function runYtdlpJson(args: string[], timeoutMs: number, label: string): Promise<YtdlpJson> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcessWithoutNullStreams;
    try { proc = spawn('yt-dlp', args); } catch (err) { return reject(new Error(`Failed to spawn yt-dlp: ${(err as Error).message}`)); }
    let stdout = '';
    let stderr = '';
    const watchdog = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { clearTimeout(watchdog); reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)); });
    proc.on('close', (code) => {
      clearTimeout(watchdog);
      if (code !== 0) return reject(parseError(stderr, code));
      try { resolve(JSON.parse(stdout)); } catch (err) { reject(new Error(`Failed to parse yt-dlp output: ${(err as Error).message}`)); }
    });
  });
}

/**
 * Search YouTube for free text: the first `count` videos of the search results
 * page (no audio, no player API).
 */
export async function searchYoutubeMany(query: string, count = 5, { timeoutMs = 30000 }: { timeoutMs?: number } = {}): Promise<SearchHit[]> {
  const data = await runYtdlpJson(['--flat-playlist', '-J', `ytsearch${count}:${query}`], timeoutMs, 'YouTube search');
  return (data.entries || []).filter((x): x is YtdlpEntry & { id: string } => !!x && /^[A-Za-z0-9_-]{11}$/.test(String(x.id || ''))).slice(0, count).map((e) => ({
    id: e.id,
    url: `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title || null,
    duration: e.duration || 0,
    channel: e.channel || e.uploader || null,
  }));
}

/**
 * Search YouTube for free text and return the top hit.
 */
export async function searchYoutube(query: string, opts?: { timeoutMs?: number }): Promise<SearchHit | null> {
  return (await searchYoutubeMany(query, 1, opts))[0] || null;
}

/**
 * Title + channel name for a YouTube video id via the public oEmbed endpoint
 * (plain HTTPS, not subject to the yt-dlp bot wall).
 */
export async function getOembed(videoId: string, { timeoutMs = 8000 }: { timeoutMs?: number } = {}): Promise<{ title: string | null; channel: string | null } | null> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json() as { title?: string; author_name?: string };
    return { title: data.title || null, channel: data.author_name || null };
  } catch {
    return null;
  }
}

/**
 * Title and duration of one video, without the player API (blocked on the
 * server's IP): oEmbed gives the title, a flat search for its id the duration
 * when that video is the top hit. Best effort.
 * @returns null if neither answered
 */
export async function previewVideo(videoId: string): Promise<{ title: string | null; channel: string | null; duration_sec: number | null } | null> {
  const [oembed, hit] = await Promise.all([
    getOembed(videoId),
    searchYoutube(videoId, { timeoutMs: 15000 }).catch(() => null),
  ]);
  const match = hit && hit.id === videoId ? hit : null;
  if (!oembed && !match) return null;
  return {
    title: (oembed && oembed.title) || (match && match.title) || null,
    channel: (oembed && oembed.channel) || (match && match.channel) || null,
    duration_sec: match && match.duration ? Number(match.duration) : null,
  };
}

