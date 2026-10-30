# la — listen-along library CLI

YouTube blocks the production server's IP, so the server can't download songs
itself. `la` runs on a home Linux machine (residential IP): it downloads songs
with yt-dlp, tags them, and uploads them to the server's music library. It can
also upload local files and fulfill listeners' song requests.

## Install

Requirements: Node >= 20 (22+ recommended), plus `yt-dlp` and `ffmpeg`/`ffprobe`
on `PATH` for downloads and conversions.

```sh
pipx install yt-dlp          # keep it fresh: pipx upgrade yt-dlp
sudo apt install ffmpeg      # or dnf / pacman

cd cli
npm link                     # puts `la` on PATH (or run: node cli/bin/la.js ...)
```

No npm dependencies: HTTP uses Node's built-in `fetch`/`FormData`, and uploads
stream from disk via `fs.openAsBlob`.

## Configure

```sh
la config set server https://listen.example.com
la config set token <api-token>
la whoami                    # GET /api/me: checks URL + token
```

Stored in `~/.config/listen-along/config.json` (mode 600; `$XDG_CONFIG_HOME`
is respected, `LA_CONFIG` overrides the path). Precedence:
`--server/--token` flags > env vars > config file > defaults.

| key          | env             | default                 |
|--------------|-----------------|-------------------------|
| `server`     | `LA_SERVER`     | —                       |
| `token`      | `LA_TOKEN`      | —                       |
| `keep-dir`   | `LA_KEEP_DIR`   | `~/Music/listen-along`  |
| `sleep`      | `LA_SLEEP`      | `3` (seconds)           |
| `ytdlp-args` | `LA_YTDLP_ARGS` | (none)                  |

Tool paths: `LA_YTDLP_BIN`, `LA_FFMPEG_BIN`, `LA_FFPROBE_BIN`.

## Commands

Every command has detailed `--help` with examples (`la <command> --help`).

| command | what it does |
|---|---|
| `la download <url-or-query>...` | YouTube video URLs, playlist URLs, `yt:<id>` or free-text search → m4a → upload |
| `la upload <file-or-dir>...` | upload local files; non-m4a is converted to AAC m4a (192k) first |
| `la requests [list]` | pending song requests (`--status pending\|fulfilled\|all`) |
| `la requests fulfill (--all \| <id>...)` | download + upload each requested song with `request_id` |
| `la requests dismiss <id>...` | dismiss requests |
| `la library [search]` | list/search library songs (`--limit`, `--offset`, `--all`) |
| `la whoami` | who the token belongs to |
| `la config set\|get\|unset\|list\|path` | configuration |

```sh
la download "Daft Punk - Digital Love"
la download "https://www.youtube.com/playlist?list=PL..." --sleep 10
la download --dry-run --json "Massive Attack - Teardrop"
la download --no-upload --keep-dir /tmp/songs "Aphex Twin - Xtal"   # no server needed
la upload ~/Music/SomeAlbum/ --artist "Some Band"
la upload ~/Music/listen-along          # bulk-upload earlier --no-upload downloads
la upload live.m4a --source-url https://www.youtube.com/watch?v=dQw4w9WgXcQ
la requests fulfill --all
la library daft punk --json
```

### How downloads work

- Format `140/bestaudio[ext=m4a]`: YouTube's AAC audio stream saved as m4a
  **without re-encoding** (the audio packets are bit-identical to YouTube's).
- Tags via yt-dlp `--embed-metadata`: title/artist from YouTube Music's
  track/artist fields; otherwise "Artist - Title" video titles are split and
  "(Official Video)"-style suffixes dropped; otherwise the channel name (minus
  " - Topic") is the artist. The thumbnail is embedded as cover art by `la`
  with ffmpeg (yt-dlp's own `--embed-thumbnail` fails for m4a unless mutagen or
  AtomicParsley is installed).
- Search queries look at the top 5 results and prefer "Topic" channels and
  "official audio", penalising live/cover/remix/lyrics/sped-up/demo uploads.
- Resumable: the library is listed once and every `youtube_id` already present
  is skipped; a `409` from the server also counts as skipped. With `--keep`,
  a local copy `<Artist> - <Title> [<id>].m4a` is reused instead of
  re-downloading.
- Every upload carries a `source_url`, the original link shown in the web
  library: the video's watch URL for downloads.
- `--sleep` seconds between downloads (default 3).

### Uploading earlier downloads (`--no-upload` / `--keep` files)

`la download --no-upload` (or `--keep`) leaves
`<Artist> - <Title> [<11-char id>].m4a` in the keep dir, with the watch URL in
the file's `comment` tag (yt-dlp's `--embed-metadata` writes `webpage_url`
there; m4a has no `purl` tag). `la upload <dir>` detects both automatically,
with no flags needed:

- `youtube_id`: `--youtube-id`, else the id in `--source-url`, else a YouTube
  URL in the comment/purl/description tags, else the `[<id>]` file-name suffix.
- `source_url`: `--source-url`, else a URL in the purl/comment tag (ignored when
  it points at a different video), else `https://www.youtube.com/watch?v=<id>`.

So a bulk `la upload ~/Music/listen-along` dedupes by `youtube_id` (songs
already in the library are skipped) and matches pending requests by
`youtube_id`, just like a direct `la download`. `--source-url URL` overrides the
link for a single file. Check first with `la upload --dry-run --json <dir>`.
- yt-dlp's JS challenge solver needs a runtime: if `deno` isn't installed,
  `la` passes `--js-runtimes node:<this node>`. Anything else (cookies for
  age-restricted videos, rate limits) goes through
  `--ytdlp-args="--cookies-from-browser firefox"` or the `ytdlp-args` config key.
  At a home IP the PO-token sidecar from `YTDLP-YOUTUBE.md` is not needed.
- HTTP 403 errors from YouTube nearly always mean yt-dlp is outdated:
  `pipx upgrade yt-dlp`.

## Output and exit codes (for scripts / AI agents)

- stdout carries only the result; progress, warnings and errors go to stderr
  (`-q` silences progress, `-v` adds yt-dlp's live output).
- `--json` on any command: stdout is exactly one JSON document; errors are a
  JSON object `{"error": {"code", "message", "hint"?}}` on stderr.
- Batch commands (`download`, `upload`, `requests fulfill`, `requests dismiss`)
  print a summary and, with `--json`:
  `{ "summary": {total, uploaded, skipped, failed, ...}, "results": [{input|file, status, youtube_id, source_url?, title, artist, reason?, error?, code?, song?}], "aborted"? }`.
  Statuses: `uploaded`, `skipped`, `failed`, `would_download`/`would_upload`
  (`--dry-run`), `downloaded` (`--no-upload`), `dismissed`.

| exit | meaning |
|---|---|
| 0 | success (batch: nothing failed) |
| 1 | failure (batch: at least one item failed) |
| 2 | usage error |
| 3 | not configured (server/token missing) |
| 4 | authentication failed (401/403) |
| 5 | server error or unreachable |
| 6 | missing dependency (yt-dlp / ffmpeg / ffprobe) |

Auth errors, an unreachable server or a missing tool abort a batch; the
partial results are still printed with an `aborted` entry.

## Server API used

All requests send `Authorization: Bearer <token>`.

- `GET /api/me` → `{ name }`
- `GET /api/library?q=&limit=&offset=` → `{ songs: [...], total }`
- `POST /api/library/upload` (multipart: `file` m4a, `title`, `artist`,
  `album`, `youtube_id`, `source_url`, `duration_sec`, `request_id`) → `201 {song}`,
  `409 {error, song}` duplicate, `400` bad input
- `GET /api/requests?status=pending|fulfilled|all` → `{ requests: [...] }`
- `POST /api/requests/:id/dismiss`

## Development

```sh
cd cli && npm test
```

Tests use Node's built-in runner against a stub HTTP server implementing the
API above; the yt-dlp and ffmpeg layers are replaced by fakes (no network).
`test/media-ffmpeg.test.js` runs the real ffmpeg commands on a generated tone
and is skipped when ffmpeg is not installed.

Layout: `bin/la.js` (entry), `src/cli.js` (dispatch, help, global options),
`src/commands/*` (one file per command), `src/pipeline.js` (download/upload
batch logic), `src/api.js`, `src/ytdlp.js`, `src/media.js`, `src/config.js`.
