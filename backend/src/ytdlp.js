/**
 * YouTube *metadata* helpers. The server no longer downloads or streams audio
 * from YouTube (its IP is blocked; the listen-along CLI downloads on a home
 * machine and uploads to the library). What is left here only resolves what a
 * user typed into a YouTube video id + title, so that a library lookup or a song
 * request can be made:
 *   - searchYoutube:      `yt-dlp --flat-playlist ytsearch1:` (search results
 *                         page only, no player API, so no PO token needed)
 *   - getPlaylistEntries: `yt-dlp --flat-playlist` (playlist page only)
 *   - getOembed:          YouTube's public oEmbed endpoint (title/channel for an id)
 * All of these are best-effort; callers must cope with failure.
 */

const { spawn } = require('child_process');

/**
 * Strip list/index params from a YouTube URL so yt-dlp fetches only the single
 * video, never an entire list. Search terms and non-URL targets pass through
 * unchanged.
 * @param {string} target - URL or search target
 * @returns {string} target with list-expanding params removed
 */
function stripListParam(target) {
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
 * @param {string} target - URL or search target
 * @returns {string|null} playlist id, or null if not an importable playlist
 */
function parsePlaylistId(target) {
  if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) return null;
  let u;
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
 * @param {string} url - playlist or watch?…&list= URL
 * @returns {Promise<Array<{id,url,title,duration,thumbnail}>>}
 */
function getPlaylistEntries(url) {
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
      let data;
      try {
        data = JSON.parse(stdout);
      } catch (err) {
        return reject(new Error(`Failed to parse playlist: ${err.message}`));
      }
      const entries = (data.entries || [])
        .filter((e) => e && e.id && e.title &&
          e.title !== '[Deleted video]' && e.title !== '[Private video]' &&
          e.title !== '[Unavailable video]')
        .map((e) => ({
          id: e.id,
          url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
          title: e.title,
          duration: e.duration || 0,
          thumbnail: (e.thumbnails && e.thumbnails.length && e.thumbnails[e.thumbnails.length - 1].url) || e.thumbnail || null,
        }));
      resolve(entries);
    });
  });
}

/**
 * Parse yt-dlp error output into a user-friendly error
 * @param {string} stderr - Error output from yt-dlp
 * @param {number} code - Exit code
 * @returns {Error} Parsed error with appropriate message
 */
function parseError(stderr, code) {
  const lowerErr = stderr.toLowerCase();

  if (lowerErr.includes('drm')) {
    const err = new Error("This track is DRM-protected and can't be played");
    err.code = 'DRM_PROTECTED';
    return err;
  }

  if (lowerErr.includes('private video')) {
    const err = new Error('This video is private');
    err.code = 'VIDEO_PRIVATE';
    return err;
  }

  // "Sign in to confirm you're not a bot" is YouTube's bot/IP challenge — it is
  // NOT an age restriction (it just contains the words "sign in"). It means this
  // server's IP is blocked; fix is cookies / a PO token / a proxy. Check this
  // BEFORE the age/sign-in cases so it isn't mislabeled as age-restricted.
  if (lowerErr.includes('not a bot') || lowerErr.includes('confirm you’re not a bot')) {
    const err = new Error("YouTube is blocking this server's IP (bot check)");
    err.code = 'BOT_CHECK';
    return err;
  }

  if (lowerErr.includes('confirm your age') || lowerErr.includes('age-restricted') ||
      lowerErr.includes('age restricted') || lowerErr.includes('inappropriate for some')) {
    const err = new Error('This video is age-restricted (needs a verified-account cookie)');
    err.code = 'AGE_RESTRICTED';
    return err;
  }

  if (lowerErr.includes('sign in') || lowerErr.includes('members-only') ||
      lowerErr.includes('join this channel') || lowerErr.includes('login required')) {
    const err = new Error('Video requires sign-in (login-only or members-only)');
    err.code = 'VIDEO_RESTRICTED';
    return err;
  }

  // Check region block before generic unavailable (more specific match first)
  if (lowerErr.includes('blocked') || lowerErr.includes('not available in your country')) {
    const err = new Error('Video is blocked in this region');
    err.code = 'VIDEO_BLOCKED';
    return err;
  }

  if (lowerErr.includes('video unavailable') || lowerErr.includes('not available')) {
    const err = new Error('Video not available');
    err.code = 'VIDEO_UNAVAILABLE';
    return err;
  }

  if (lowerErr.includes('no video formats') || lowerErr.includes('no suitable format')) {
    const err = new Error('No audio format available');
    err.code = 'NO_FORMAT';
    return err;
  }

  if (lowerErr.includes('unable to extract') || lowerErr.includes('no results') || lowerErr.includes('http error 404')) {
    const err = new Error('Video not found');
    err.code = 'NOT_FOUND';
    return err;
  }

  // Generic error
  const err = new Error(`yt-dlp error (code ${code}): ${stderr.slice(0, 200)}`);
  err.code = 'YTDLP_ERROR';
  return err;
}

/**
 * Check if yt-dlp is available
 * @returns {Promise<boolean>}
 */
function checkAvailable() {
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
 * @returns {Promise<boolean>}
 */
function createAvailabilityCache({ check = checkAvailable, maxAgeMs = 10 * 60 * 1000, now = Date.now } = {}) {
  let value = null;
  let at = 0;
  let pending = null;
  function refresh() {
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

const availableCached = createAvailabilityCache();

/**
 * Run yt-dlp with args and return parsed JSON from stdout.
 */
function runYtdlpJson(args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn('yt-dlp', args); } catch (err) { return reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)); }
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
      try { resolve(JSON.parse(stdout)); } catch (err) { reject(new Error(`Failed to parse yt-dlp output: ${err.message}`)); }
    });
  });
}

/**
 * Search YouTube for free text and return the top hit (no audio, no player
 * API — just the search results page).
 * @returns {Promise<{id, url, title, duration, channel}|null>}
 */
async function searchYoutube(query) {
  const data = await runYtdlpJson(['--flat-playlist', '-J', `ytsearch1:${query}`], 30000, 'YouTube search');
  const e = (data.entries || []).find((x) => x && x.id);
  if (!e) return null;
  return {
    id: e.id,
    url: `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title || null,
    duration: e.duration || 0,
    channel: e.channel || e.uploader || null,
  };
}

/**
 * Title + channel name for a YouTube video id via the public oEmbed endpoint
 * (plain HTTPS, not subject to the yt-dlp bot wall).
 * @returns {Promise<{title, channel}|null>}
 */
async function getOembed(videoId, { timeoutMs = 8000 } = {}) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title || null, channel: data.author_name || null };
  } catch {
    return null;
  }
}

module.exports = {
  parseError,
  checkAvailable,
  availableCached,
  createAvailabilityCache,
  stripListParam,
  parsePlaylistId,
  getPlaylistEntries,
  searchYoutube,
  getOembed
};
