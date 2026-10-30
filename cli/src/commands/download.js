'use strict';

const os = require('os');
const { UsageError } = require('../errors');
const { Batch, runBatch } = require('../batch');
const { downloadAndUpload } = require('../pipeline');
const { PLAYLIST_OPTIONS, preparePlaylistTarget, attachPlaylist, playlistSummaryLine } = require('../playlists');

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
    allowSimilar: !!values['allow-similar'],
    replace: values.replace,
  };
}

/** Options shared by `la download` and `la upload`. */
const DEDUPE_OPTIONS = {
  'allow-similar': { type: 'boolean', desc: 'Upload even when a song with the same artist, title and duration (±3s) is already in the library' },
  replace: { type: 'string', value: 'SONG_ID', desc: 'Replace the audio and metadata of this library song (keeps its id, so playlists holding it are fixed); one input only' },
};

/** Usage checks for --replace (shared by download and upload). */
function checkReplace(values, count, what) {
  if (values.replace === undefined) return;
  if (!String(values.replace).trim()) throw new UsageError('--replace needs a library song id (see `la library <search>`)');
  if (count !== 1) throw new UsageError(`--replace takes exactly one ${what} (got ${count})`);
  for (const k of ['playlist', 'allow-similar', 'no-upload', 'request-id']) {
    if (values[k] !== undefined && values[k] !== false) throw new UsageError(`--replace cannot be combined with --${k}`);
  }
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
youtube_id, source_url (the video's watch URL, shown as the song's source link
in the web library), duration and tags. yt-dlp also writes the watch URL into the
file's comment tag, so --keep / --no-upload copies can later be bulk-uploaded with
\`la upload <dir>\` and keep both the youtube_id and the source link.

Resumable: the library is listed once up front and every video whose youtube_id is
already there is skipped (a 409 from the server also counts as "skipped"). With
--keep, an existing local copy "... [<id>].m4a" in the keep dir is reused instead
of downloading again. Downloads are throttled by --sleep.

Needs yt-dlp and ffmpeg/ffprobe on PATH (exit 6 with an install hint if missing).
A home/residential IP normally needs no PO token or cookies; pass anything else
yt-dlp needs through --ytdlp-args (e.g. cookies for age-restricted videos).

Duplicates: besides the youtube_id listing, the server is asked before each
download (search and playlist results: artist/title guessed from the video
title or channel, plus duration) and again after it (the file's sha256 and its
tags) whether the song is already there. Skip reasons: "already in library"
(same youtube_id), "duplicate_hash" (the very same file), "duplicate_metadata"
(same normalized artist + title — case, accents, Turkish letters, "(Official
Video)", "- Remastered 2011", "feat. ..." ignored — and duration within ±3s).
Each such skip names the existing song in "duplicate_of" ({id, title, artist}).
Metadata matches are only probable: --allow-similar uploads them anyway. The
server re-checks every upload, so a race between two uploaders cannot add the
same song twice. Older servers without the check endpoint just get the upload.

--replace <song-id> fixes a wrongly uploaded song: the single URL/query is
downloaded and REPLACES the audio, title/artist/album, youtube_id, source link
and cover of that library song. The song keeps its id, so every playlist that
holds it plays the new file. Anyone with a token may do this; the server keeps
an audit trail. Fails (exit 1) when the file or youtube_id already belongs to a
different song (code duplicate_hash / already_in_library), when it is the same
file (same_file) or the id is unknown (not_found).

--playlist <id|name> also adds every song that ends up in the library — uploaded
now, or skipped because it was already there — to that server playlist (id, or
exact case-insensitive name among the playlists you can see; an ambiguous name
fails listing the ids). Songs already in the playlist are not added twice. A
missing playlist is an error (exit 1) unless --create-playlist is given, which
creates it public (like the web app) or private with --private. Not with
--no-upload; with --dry-run nothing is created or added.`,
  options: {
    ...DOWNLOAD_OPTIONS,
    'no-upload': { type: 'boolean', desc: 'Only download into the keep dir; no server needed' },
    'no-playlist': { type: 'boolean', desc: 'For watch URLs with &list=..., take just the video, not the playlist' },
    ...DEDUPE_OPTIONS,
    ...PLAYLIST_OPTIONS,
  },
  output: `Progress on stderr. stdout: a summary (or --json document):
{ "summary": { "total", "uploaded", "skipped", "failed", ["would_download"|"downloaded"] },
  "results": [ { "input", "status": "uploaded|skipped|failed|would_download|downloaded",
                 "youtube_id", "url", "source_url"?, "title", "artist", "reason"?, "error"?, "code"?,
                 "song"?: <server song object>, "local_file"?, "matched"?: {title, channel},
                 "duplicate_of"?: {id, title, artist, youtube_id?, match} } ],
  "aborted"?: { "code", "message" } }
Skip reasons: "already in library", "duplicate_hash", "duplicate_metadata",
"duplicate in this batch", "duplicate (server already has it)" (older servers).
With --replace: status "replaced" (or "would_replace" with --dry-run), counted in
summary.replaced, with "replaced_id" and "previous": {youtube_id, source_url,
title, artist, album, duration_sec, file_version}.
With --playlist, also "playlist": { "id", "name", "visibility", "created", "added",
"already_in_playlist", "failed" } and on each uploaded/skipped result
"playlist_status": "added|already_in_playlist|failed" (+ "playlist_error").
Exit 0 if nothing failed, 1 if any item (or playlist add) failed, 4/5/6 if the batch was aborted.
--playlist problems before the batch starts: exit 1 (PLAYLIST_NOT_FOUND, AMBIGUOUS).
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
    'la download --playlist "Road trip" "Daft Punk - Digital Love"',
    'la download --playlist "Late night" --create-playlist --private "Massive Attack - Teardrop"',
    'la download --allow-similar "Queen - Bohemian Rhapsody (Live Aid)"',
    'la download https://youtu.be/RIGHTVIDEO1 --replace 3f2b…-song-id   # fix a wrong upload',
  ],
  DOWNLOAD_OPTIONS,
  DEDUPE_OPTIONS,
  checkReplace,
  pipelineOptions,
  async run(ctx, values, positionals) {
    if (!positionals.length) throw new UsageError('Give at least one YouTube URL, playlist URL or search query', 'See `la download --help`');
    checkReplace(values, positionals.length, 'URL or query');
    const opts = pipelineOptions(ctx, values);
    if (opts.upload) ctx.getApi(); // fail fast (exit 3) if not configured
    if (!opts.upload && values.playlist !== undefined) throw new UsageError('--playlist needs an upload; it cannot be used with --no-upload');
    const target = await preparePlaylistTarget(ctx, values, { dryRun: opts.dryRun });
    const deps = { out: ctx.out, ytdlp: ctx.makeYtdlp(values['ytdlp-args']), media: ctx.makeMedia(), getApi: ctx.getApi, sleep: ctx.sleep };
    const inputs = positionals.map((input) => ({ input, noPlaylist: !!values['no-playlist'] }));
    const batch = new Batch(ctx.out);
    if (target && !opts.dryRun) attachPlaylist(batch, ctx.getApi(), target, ctx.out);
    const extra = { dry_run: opts.dryRun || undefined };
    if (target) Object.assign(extra, { playlist: target, playlistLine: () => playlistSummaryLine(target) });
    return runBatch(ctx.out, batch, () => downloadAndUpload(deps, inputs, opts, batch), extra);
  },
};
