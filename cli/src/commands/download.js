'use strict';

const os = require('os');
const { UsageError } = require('../errors');
const { Batch, runBatch } = require('../batch');
const { downloadAndUpload } = require('../pipeline');

/** Options shared by `la download` and `la requests fulfill`. */
const DOWNLOAD_OPTIONS = {
  sleep: { type: 'string', value: 'SEC', desc: 'Seconds to wait between YouTube downloads (config `sleep`, default 3)' },
  keep: { type: 'boolean', desc: 'Also keep a local copy "<Artist> - <Title> [<id>].m4a" in the keep dir' },
  'keep-dir': { type: 'string', value: 'DIR', desc: 'Directory for --keep / --no-upload copies (config `keep-dir`, default ~/Music/listen-along)' },
  'dry-run': { type: 'boolean', desc: 'Resolve URLs/searches and check the library, but download/upload nothing' },
  'ytdlp-args': { type: 'string', multiple: true, value: 'ARGS', desc: 'Extra yt-dlp arguments, shell-quoted; use the = form: --ytdlp-args="--cookies-from-browser firefox"' },
};

function parseSleep(ctx, values) {
  if (values.sleep === undefined) return Number(ctx.cfg.values.sleep);
  const n = Number(values.sleep);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--sleep must be a non-negative number, got: ${values.sleep}`);
  return n;
}

function expandHome(p) {
  return p ? p.replace(/^~(?=$|\/)/, os.homedir()) : p;
}

/** Build pipeline options from parsed flags. */
function pipelineOptions(ctx, values) {
  return {
    dryRun: !!values['dry-run'],
    keep: !!values.keep,
    keepDir: expandHome(values['keep-dir'] || ctx.cfg.values['keep-dir']),
    sleepSec: parseSleep(ctx, values),
    upload: !values['no-upload'],
  };
}

module.exports = {
  name: 'download',
  aliases: ['dl'],
  summary: 'Download songs from YouTube (URL, playlist or search) and upload them to the library',
  usage: 'la download [options] <url-or-query>...',
  description: `Each argument is one of:
  - a YouTube video URL        https://www.youtube.com/watch?v=ID, https://youtu.be/ID,
                               music.youtube.com/watch?v=ID, /shorts/ID
  - a YouTube playlist URL     https://www.youtube.com/playlist?list=PL...  (also a watch URL
                               carrying list=; radio/mix lists "RD..." count as single videos;
                               --no-playlist treats any watch URL as the single video)
  - "yt:<11-char id>"          a bare video id
  - free text                  searched on YouTube ("Artist - Title" works best). The top 5
                               results are scored: "<Artist> - Topic" channels (YouTube Music)
                               and "official audio" win; live/cover/remix/lyrics/sped-up
                               uploads lose (unless your query asks for them).
  - any other URL              handed to yt-dlp as-is

For every video: yt-dlp downloads the AAC audio stream as m4a WITHOUT re-encoding
(format 140, fallback bestaudio[ext=m4a]), embeds title/artist (from the YouTube
Music track/artist fields, else "Artist - Title" parsed from the video title, else
the channel) and the thumbnail as cover art, then the file is uploaded with its
youtube_id, duration and tags.

Resumable: the library is listed once up front and every video whose youtube_id is
already there is skipped (a 409 from the server also counts as "skipped"). With
--keep, an existing local copy "... [<id>].m4a" in the keep dir is reused instead
of downloading again. Downloads are throttled by --sleep.

Needs yt-dlp and ffmpeg/ffprobe on PATH (exit 6 with an install hint if missing).
A home/residential IP normally needs no PO token or cookies; pass anything else
yt-dlp needs through --ytdlp-args (e.g. cookies for age-restricted videos).`,
  options: {
    ...DOWNLOAD_OPTIONS,
    'no-upload': { type: 'boolean', desc: 'Only download into the keep dir; no server needed' },
    'no-playlist': { type: 'boolean', desc: 'For watch URLs with &list=..., take just the video, not the playlist' },
  },
  output: `Progress on stderr. stdout: a summary (or --json document):
{ "summary": { "total", "uploaded", "skipped", "failed", ["would_download"|"downloaded"] },
  "results": [ { "input", "status": "uploaded|skipped|failed|would_download|downloaded",
                 "youtube_id", "url", "title", "artist", "reason"?, "error"?, "code"?,
                 "song"?: <server song object>, "local_file"?, "matched"?: {title, channel} } ],
  "aborted"?: { "code", "message" } }
Exit 0 if nothing failed, 1 if any item failed, 4/5/6 if the batch was aborted.
Failure codes include BOT_CHECK, AGE_RESTRICTED, VIDEO_UNAVAILABLE, VIDEO_PRIVATE,
REGION_BLOCKED, NO_M4A_FORMAT, NOT_FOUND, MISSING_TAGS, HTTP_400, NETWORK, YTDLP_FAILED.`,
  examples: [
    'la download https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'la download "Daft Punk - Digital Love" "Justice - D.A.N.C.E."',
    'la download "https://www.youtube.com/playlist?list=PLxxxx" --sleep 10',
    'la download --dry-run --json "Massive Attack - Teardrop"',
    'la download --keep --keep-dir ~/Music/la "Boards of Canada - Roygbiv"',
    'la download --no-upload "Aphex Twin - Xtal"            # local only, no server',
    'la download --ytdlp-args="--cookies-from-browser firefox" https://youtu.be/ID',
  ],
  DOWNLOAD_OPTIONS,
  pipelineOptions,
  async run(ctx, values, positionals) {
    if (!positionals.length) throw new UsageError('Give at least one YouTube URL, playlist URL or search query', 'See `la download --help`');
    const opts = pipelineOptions(ctx, values);
    if (opts.upload) ctx.getApi(); // fail fast (exit 3) if not configured
    const deps = { out: ctx.out, ytdlp: ctx.makeYtdlp(values['ytdlp-args']), media: ctx.makeMedia(), getApi: ctx.getApi, sleep: ctx.sleep };
    const inputs = positionals.map((input) => ({ input, noPlaylist: !!values['no-playlist'] }));
    const batch = new Batch(ctx.out);
    return runBatch(ctx.out, batch, () => downloadAndUpload(deps, inputs, opts, batch), { dry_run: opts.dryRun || undefined });
  },
};
