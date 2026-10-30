'use strict';

const { UsageError } = require('../errors');
const { Batch, runBatch } = require('../batch');
const { uploadFiles } = require('../pipeline');
const { expandInputs, AUDIO_EXTS } = require('../media');
const { ID_RE, isHttpUrl } = require('../youtube');

module.exports = {
  name: 'upload',
  aliases: ['up'],
  summary: 'Upload local audio files or directories to the library (converts non-m4a to AAC m4a)',
  usage: 'la upload [options] <file-or-dir>...',
  description: `Uploads local audio files. Directories are scanned recursively for audio files
(${[...AUDIO_EXTS].join(' ')}); hidden files are ignored.

The server only accepts m4a: AAC-in-MP4 files (.m4a/.mp4) are uploaded as-is; anything
else (mp3, flac, opus, ...) is converted locally with ffmpeg to AAC m4a at --bitrate
(default 192k), keeping tags and cover art. Your original files are never modified.

Metadata comes from the file's tags via ffprobe: title, artist (falls back to
album_artist/composer), album, duration. --title/--artist/--album override the tags.
A file without title or artist (and no override) fails with code MISSING_TAGS.
The youtube_id and the original source link (source_url) are detected
automatically, so files written earlier by \`la download --no-upload\` / \`--keep\`
("<Artist> - <Title> [<id>].m4a", watch URL in the comment tag) upload with
both and need no flags:
  youtube_id  --youtube-id, else the id in --source-url, else a YouTube URL in the
              comment/purl/description tags (yt-dlp writes the watch URL into
              comment), else a "[<11-char id>]" suffix in the file name
  source_url  --source-url, else a URL in the purl/comment tag (ignored if it is for
              a different video than youtube_id), else
              https://www.youtube.com/watch?v=<youtube_id>
Files whose youtube_id is already in the library are skipped. Server-side
duplicates (409) are reported as skipped.`,
  options: {
    title: { type: 'string', value: 'TEXT', desc: 'Override title (only with a single file)' },
    artist: { type: 'string', value: 'TEXT', desc: 'Override artist for all files' },
    album: { type: 'string', value: 'TEXT', desc: 'Override album for all files' },
    'youtube-id': { type: 'string', value: 'ID', desc: 'YouTube video id of the song (only with a single file)' },
    'source-url': { type: 'string', value: 'URL', desc: 'Original source link of the song, http(s) (only with a single file)' },
    'request-id': { type: 'string', value: 'ID', desc: 'Mark this upload as fulfilling a song request (single file)' },
    bitrate: { type: 'string', value: 'RATE', desc: 'AAC bitrate when converting', default: '192k' },
    'dry-run': { type: 'boolean', desc: 'Read tags and report what would be uploaded; upload nothing' },
  },
  output: `Progress on stderr. stdout: a summary (or --json document):
{ "summary": { "total", "uploaded", "skipped", "failed", ["would_upload"] },
  "results": [ { "file", "status": "uploaded|skipped|failed|would_upload", "title", "artist",
                 "youtube_id"?, "source_url"?, "converted": bool, "song"?, "fields"? (dry-run), "reason"?,
                 "error"?, "code"? } ] }
Exit 0 if nothing failed, 1 if any file failed, 2 for bad arguments (e.g. missing path).`,
  examples: [
    'la upload song.m4a',
    'la upload ~/Music/Album/ --artist "Some Band" --album "Some Album"',
    'la upload track01.flac --title "Intro" --artist "Some Band"',
    'la upload "Song [dQw4w9WgXcQ].m4a"          # youtube_id from the file name',
    'la upload ~/Music/listen-along              # bulk upload of `la download --no-upload` files',
    'la upload live.m4a --source-url https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'la upload --dry-run --json ~/Music/',
  ],
  async run(ctx, values, positionals) {
    if (!positionals.length) throw new UsageError('Give at least one file or directory', 'See `la upload --help`');
    const { files, missing } = expandInputs(positionals);
    if (missing.length) throw new UsageError(`No such file or directory: ${missing.join(', ')}`);
    if (!files.length) throw new UsageError('No audio files found in the given paths');
    for (const k of ['title', 'youtube-id', 'source-url', 'request-id']) {
      if (values[k] !== undefined && files.length > 1) throw new UsageError(`--${k} can only be used with a single file (got ${files.length})`);
    }
    if (values['youtube-id'] !== undefined && !ID_RE.test(values['youtube-id'])) {
      throw new UsageError(`--youtube-id must be an 11-character YouTube id, got: ${values['youtube-id']}`);
    }
    if (values['source-url'] !== undefined && !isHttpUrl(values['source-url'])) {
      throw new UsageError(`--source-url must be an http(s) URL, got: ${values['source-url']}`);
    }
    if (values.bitrate !== undefined && !/^\d+k?$/i.test(values.bitrate)) throw new UsageError(`Invalid --bitrate: ${values.bitrate} (e.g. 192k)`);
    ctx.getApi(); // fail fast if not configured
    const deps = { out: ctx.out, media: ctx.makeMedia(), getApi: ctx.getApi };
    const opts = {
      overrides: { title: values.title, artist: values.artist, album: values.album, youtube_id: values['youtube-id'], source_url: values['source-url'] },
      dryRun: !!values['dry-run'],
      requestId: values['request-id'],
      bitrate: values.bitrate || '192k',
    };
    const batch = new Batch(ctx.out);
    return runBatch(ctx.out, batch, () => uploadFiles(deps, files, opts, batch), { dry_run: opts.dryRun || undefined });
  },
};
