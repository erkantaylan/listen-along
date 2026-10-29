'use strict';

const fs = require('fs');
const path = require('path');
const { run: defaultRun, missingDependency } = require('./proc');
const { CliError } = require('./errors');

/**
 * Format selection: YouTube's AAC-LC 128k audio-only stream (itag 140) is an
 * m4a we can keep byte-for-byte (no re-encode). Fall back to any m4a audio.
 */
const FORMAT = '140/bestaudio[ext=m4a]';

/**
 * Metadata massaging done inside yt-dlp so the tags it embeds are good:
 *  - if the video has no `artist`, split "Artist - Title" titles into
 *    artist/track (the "|" prefix trick only matches when artist is empty);
 *  - strip "(Official Video)"-style suffixes from the track title;
 *  - drop the " - Topic" suffix YouTube Music channels carry.
 * yt-dlp's --embed-metadata then writes title=track||title, artist=artist||uploader.
 */
const METADATA_ARGS = [
  '--parse-metadata', '%(artist|)s|%(title)s:^\\|(?P<artist>.+?) - (?P<track>.+)$',
  '--replace-in-metadata', 'track,title', '(?i)\\s*[\\(\\[](?:official\\s+)?(?:hd\\s+)?(?:music\\s+|lyric\\s+)?(?:video|audio|visualizer|lyrics?)(?:\\s+hd)?[\\)\\]]', '',
  '--replace-in-metadata', 'uploader,channel', ' - Topic$', '',
  // Don't stuff the whole video description into the audio file's tags.
  '--parse-metadata', ':(?P<meta_description>)',
  '--parse-metadata', ':(?P<meta_synopsis>)',
];

/** Fields printed as JSON after the file is moved into place. */
const PRINT_TEMPLATE = 'after_move:%(.{id,title,track,artist,album,uploader,channel,duration,filepath,webpage_url})j';

/**
 * Turn yt-dlp stderr into a short, stable error. The bot-check and the
 * age-gate both mention "sign in"; keep them apart (see YTDLP-YOUTUBE.md).
 */
function parseError(stderr, exitCode) {
  const lower = String(stderr || '').toLowerCase();
  const lastError = (String(stderr || '').split('\n').filter((l) => /ERROR:/.test(l)).pop() || '').replace(/^.*?ERROR:\s*/, '').trim();
  const mk = (code, message) => {
    const err = new CliError(message, { code });
    err.detail = lastError || undefined;
    return err;
  };
  if (lower.includes('drm')) return mk('DRM_PROTECTED', 'DRM-protected, cannot be downloaded');
  if (lower.includes('private video')) return mk('VIDEO_PRIVATE', 'Video is private');
  if (lower.includes('not a bot') || lower.includes('confirm you’re not a bot')) {
    return mk('BOT_CHECK', 'YouTube bot check ("Sign in to confirm you\'re not a bot"): this IP is being blocked. Try later, pass cookies via --ytdlp-args "--cookies-from-browser firefox", or update yt-dlp.');
  }
  if (lower.includes('confirm your age') || lower.includes('age-restricted') || lower.includes('age restricted') || lower.includes('inappropriate for some')) {
    return mk('AGE_RESTRICTED', 'Age-restricted video: needs cookies from a logged-in account (--ytdlp-args "--cookies-from-browser firefox")');
  }
  if (lower.includes('members-only') || lower.includes('join this channel') || lower.includes('login required')) {
    return mk('VIDEO_RESTRICTED', 'Video requires sign-in (members-only or login-only)');
  }
  if (lower.includes('not available in your country') || lower.includes('blocked it in your country')) {
    return mk('REGION_BLOCKED', 'Video is not available in your country');
  }
  if (lower.includes('requested format is not available')) {
    return mk('NO_M4A_FORMAT', 'No m4a/AAC audio format offered for this video (try updating yt-dlp; or pass --ytdlp-args "--extractor-args youtube:player_client=default")');
  }
  if (lower.includes('signature solving failed') || lower.includes('n challenge solving failed') || lower.includes('js runtime')) {
    return mk('JS_CHALLENGE', 'yt-dlp could not solve YouTube\'s JS challenge: update yt-dlp and make sure a JS runtime (deno or node >= 22) is available');
  }
  if (lower.includes('video unavailable') || lower.includes('removed') || lower.includes('does not exist') || lower.includes('this video is not available')) {
    return mk('VIDEO_UNAVAILABLE', 'Video is unavailable');
  }
  if (lower.includes('unable to download') || lower.includes('http error') || lower.includes('timed out') || lower.includes('connection')) {
    return mk('NETWORK', `Network error while downloading${lastError ? `: ${lastError}` : ''}`);
  }
  return mk('YTDLP_FAILED', `yt-dlp failed (exit ${exitCode})${lastError ? `: ${lastError}` : ''}`);
}

/** Does `bin` resolve to an executable on PATH? */
function onPath(bin, env = process.env) {
  if (bin.includes('/')) return fs.existsSync(bin);
  return (env.PATH || '').split(path.delimiter).some((dir) => {
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { return false; }
  });
}

/**
 * yt-dlp only enables Deno as JS runtime by default. When Deno isn't
 * installed, point it at the Node running this CLI (needs Node >= 20; the
 * yt-dlp EJS docs recommend 22+).
 */
function jsRuntimeArgs(extraArgs, env = process.env) {
  if (extraArgs.some((a) => /^--(no-)?js-runtimes/.test(a))) return [];
  if (onPath('deno', env)) return [];
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 20 ? ['--js-runtimes', `node:${process.execPath}`] : [];
}

/**
 * The yt-dlp invocation layer. Everything that spawns yt-dlp lives here so
 * tests can swap it for a fake.
 */
class YtDlp {
  /**
   * @param {object} [opts]
   * @param {string} [opts.bin] - yt-dlp binary (default $LA_YTDLP_BIN or 'yt-dlp')
   * @param {string[]} [opts.extraArgs] - appended to every call (--ytdlp-args)
   * @param {Function} [opts.run] - process runner (for tests)
   * @param {(line: string) => void} [opts.onStderr] - live stderr (verbose mode)
   */
  constructor({ bin, extraArgs = [], run = defaultRun, onStderr, env = process.env } = {}) {
    this.bin = bin || env.LA_YTDLP_BIN || 'yt-dlp';
    this.extraArgs = extraArgs;
    this.run = run;
    this.onStderr = onStderr;
    this.env = env;
    this.baseArgs = ['--no-warnings', '--ignore-config', ...jsRuntimeArgs(extraArgs, env)];
  }

  /**
   * Run yt-dlp. User extra args go before `--` so they stay options, and the
   * target(s) after it so a value can never be parsed as an option.
   */
  async exec(args, targets = []) {
    const argv = [...this.baseArgs, ...args, ...this.extraArgs, '--', ...targets];
    return this.run(this.bin, argv, { name: 'yt-dlp', onStderr: this.onStderr });
  }

  /** Verify yt-dlp runs; returns its version string. */
  async version() {
    const { code, stdout } = await this.run(this.bin, ['--version'], { name: 'yt-dlp' });
    if (code !== 0) throw missingDependency('yt-dlp', this.bin);
    return stdout.trim();
  }

  /** Run a metadata-only (no download) query that prints one JSON document. */
  async json(args, target) {
    const { code, stdout, stderr } = await this.exec(['-J', '--flat-playlist', ...args], [target]);
    if (code !== 0) throw parseError(stderr, code);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new CliError('yt-dlp returned unparseable JSON', { code: 'YTDLP_FAILED' });
    }
  }

  /** List a playlist's entries: [{ id, title, url, channel, duration }]. */
  async playlist(url) {
    const data = await this.json(['--yes-playlist'], url);
    return (data.entries || [])
      .filter((e) => e && e.id && !/^\[(deleted|private) video\]$/i.test(e.title || ''))
      .map((e) => ({
        id: e.id,
        title: e.title,
        channel: e.channel || e.uploader,
        duration: e.duration,
        url: `https://www.youtube.com/watch?v=${e.id}`,
      }));
  }

  /** Search YouTube: top `n` results (flat, cheap — one request). */
  async search(query, n = 5) {
    const data = await this.json([], `ytsearch${n}:${query}`);
    return (data.entries || []).filter((e) => e && e.id).map((e) => ({
      id: e.id,
      title: e.title,
      channel: e.channel || e.uploader,
      duration: e.duration,
      url: `https://www.youtube.com/watch?v=${e.id}`,
    }));
  }

  /**
   * Download one video's audio as m4a (no re-encode) with embedded tags into
   * `outDir`, plus a JPEG thumbnail next to it (embed with Media.embedCover).
   * @returns {Promise<{ file: string, thumbnail: string|null, info: object }>}
   */
  async download(url, { outDir }) {
    const args = [
      '--no-playlist',
      '-f', FORMAT,
      '--embed-metadata',
      // Cover is written next to the file and embedded by Media.embedCover:
      // yt-dlp's --embed-thumbnail needs mutagen/AtomicParsley for m4a.
      '--write-thumbnail',
      '--convert-thumbnails', 'jpg',
      ...METADATA_ARGS,
      '--no-simulate',
      '--no-progress',
      '--print', PRINT_TEMPLATE,
      '-P', outDir,
      '-o', '%(id)s.%(ext)s',
    ];
    const { code, stdout, stderr } = await this.exec(args, [url]);
    if (code !== 0) throw parseError(stderr, code);
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    let info;
    try { info = JSON.parse(line); } catch {
      throw new CliError(`yt-dlp did not report the downloaded file (output: ${String(line).slice(0, 200)})`, { code: 'YTDLP_FAILED' });
    }
    if (!info.filepath || !fs.existsSync(info.filepath)) {
      throw new CliError(`yt-dlp reported a file that does not exist: ${info.filepath}`, { code: 'YTDLP_FAILED' });
    }
    const thumb = path.join(path.dirname(info.filepath), `${path.parse(info.filepath).name}.jpg`);
    return { file: info.filepath, thumbnail: fs.existsSync(thumb) ? thumb : null, info };
  }
}

module.exports = { YtDlp, parseError, FORMAT, METADATA_ARGS, jsRuntimeArgs };
