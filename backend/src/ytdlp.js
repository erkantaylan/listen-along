const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const COOKIES_PATH = path.join(path.dirname(process.env.SONGS_PATH || '/data/songs'), 'cookies.txt');

// yt-dlp YouTube player client(s). Switchable via env so the client can be
// changed (e.g. to 'web_safari,mweb' or 'tv') without a code redeploy when
// YouTube tightens restrictions. Comma-separate for fallbacks.
const PLAYER_CLIENT = process.env.YTDLP_PLAYER_CLIENT || 'android_vr';

// Optional bgutil PO Token provider (sidecar) base URL. Empty = disabled (e.g.
// local dev). In production it points at the bgutil-provider container so yt-dlp
// can fetch Proof-of-Origin tokens and get past YouTube's "not a bot" IP block.
const POT_BASE_URL = process.env.YTDLP_POT_BASE_URL || '';

function getPotArgs() {
  return POT_BASE_URL
    ? ['--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_BASE_URL}`]
    : [];
}

function getCookiesArgs() {
  try {
    if (fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 0) {
      return ['--cookies', COOKIES_PATH];
    }
  } catch {}
  return [];
}

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
 * Extract metadata for a YouTube video or search query
 * @param {string} query - YouTube URL or search term
 * @returns {Promise<Object>} Video metadata
 */
function getMetadata(query) {
  return new Promise((resolve, reject) => {
    const isUrl = query.startsWith('http://') || query.startsWith('https://');
    const target = isUrl ? stripListParam(query) : `ytsearch:${query}`;

    const args = [
      '-j',                    // JSON output
      '-f', 'bestaudio',       // Audio format selection
      '--extractor-args', `youtube:player_client=${PLAYER_CLIENT}`,
      ...getPotArgs(),         // PO token provider (bgutil) to clear the bot/IP block
      ...getCookiesArgs(),     // authenticate metadata lookups too, not just downloads
      target
    ];

    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    // Watchdog: kill a hung yt-dlp so it can't hold an HTTP/socket handler
    // open until the proxy 504s. Cleared on normal close/error below.
    const watchdog = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('yt-dlp metadata timed out after 45s'));
    }, 45000);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(watchdog);
      if (code !== 0) {
        const error = parseError(stderr, code);
        return reject(error);
      }

      try {
        const info = JSON.parse(stdout);
        resolve({
          id: info.id,
          title: info.title,
          duration: info.duration,
          thumbnail: info.thumbnail,
          uploader: info.uploader,
          url: info.webpage_url
        });
      } catch (e) {
        reject(new Error('Failed to parse video metadata'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(watchdog);
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Create a transcoded audio stream (converts to mp3 via ffmpeg)
 * @param {string} query - YouTube URL or search term
 * @returns {Object} { stream, kill } - Audio stream and cleanup function
 */
function createTranscodedStream(query) {
  const isUrl = query.startsWith('http://') || query.startsWith('https://');
  const target = isUrl ? stripListParam(query) : `ytsearch:${query}`;

  // yt-dlp outputs raw audio to stdout
  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio',
    '-o', '-',
    '--extractor-args', `youtube:player_client=${PLAYER_CLIENT}`,
    ...getPotArgs(),
    ...getCookiesArgs(),
    target
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // ffmpeg transcodes to mp3 for browser compatibility
  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',           // Input from stdin
    '-f', 'mp3',              // Output format
    '-ab', '128k',            // Bitrate
    '-'                       // Output to stdout
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Pipe yt-dlp output to ffmpeg input
  ytdlp.stdout.pipe(ffmpeg.stdin);

  const kill = () => {
    ytdlp.kill('SIGTERM');
    ffmpeg.kill('SIGTERM');
  };

  // Handle yt-dlp errors
  let ytdlpError = '';
  ytdlp.stderr.on('data', (data) => {
    ytdlpError += data.toString();
  });

  // Drain ffmpeg's stderr. ffmpeg is verbose on stderr, and if nothing reads it
  // the ~64KB OS pipe buffer fills and ffmpeg blocks forever. Consume/discard it.
  ffmpeg.stderr.on('data', () => {});

  ytdlp.on('close', (code) => {
    if (code !== 0 && code !== null) {
      ffmpeg.stdin.end();
    }
  });

  // Log spawn failures and tear down the sibling so we don't leave half the
  // pipe running. No total-duration timeout here: this streams for the whole
  // song; client disconnect is handled by req.on('close') -> kill() in the route.
  ytdlp.on('error', (err) => {
    console.error('[createTranscodedStream] yt-dlp error:', err.message);
    ffmpeg.kill('SIGTERM');
  });

  ffmpeg.on('error', (err) => {
    console.error('[createTranscodedStream] ffmpeg error:', err.message);
    ytdlp.kill('SIGTERM');
  });

  return {
    stream: ffmpeg.stdout,
    ytdlp,
    ffmpeg,
    kill,
    getError: () => ytdlpError
  };
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
    const err = new Error("YouTube is blocking this server's IP (bot check). Add cookies or a PO token.");
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

module.exports = {
  getMetadata,
  createTranscodedStream,
  parseError,
  checkAvailable,
  stripListParam
};
