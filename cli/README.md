# la — listen-along library CLI

YouTube blocks the production server's IP, so the server can't download songs
itself. `la` runs on a home Linux machine (residential IP): it downloads songs
with yt-dlp, tags them, and uploads them to the server's music library. It can
also upload local files, fulfill listeners' song requests, pull library
songs down to any computer (`la pull`), and run as a **downloader**
(`la worker`, Linux / macOS / Windows) that takes download jobs from the
server: song requests and the web app's Download box.

## Install

Requirements: Node >= 20 (22+ for `la worker`), plus `yt-dlp` and `ffmpeg`/`ffprobe`
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

Get a token from the web app: sign in, open your **Profile**, and under
**CLI tokens** create one with a label (e.g. "Desktop", one per computer). The
token is shown once, together with the commands below. Only approved accounts
can create tokens. Uploads are credited to your account; revoke a token from
the same page when you stop using that machine.

```sh
la config set server https://listen.example.com
la config set token <api-token>
la whoami                    # GET /api/me: checks URL + token, shows your name
```

Stored in `~/.config/listen-along/config.json` (mode 600; `$XDG_CONFIG_HOME`
is respected, `LA_CONFIG` overrides the path). Precedence:
`--server/--token` flags > env vars > config file > defaults.

| key          | env             | default                 |
|--------------|-----------------|-------------------------|
| `server`     | `LA_SERVER`     | —                       |
| `token`      | `LA_TOKEN`      | —                       |
| `keep-dir`   | `LA_KEEP_DIR`   | `~/Music/listen-along` (also `la pull`'s default `--dir`) |
| `sleep`      | `LA_SLEEP`      | `3` (seconds)           |
| `ytdlp-args` | `LA_YTDLP_ARGS` | (none)                  |

Tool paths: `LA_YTDLP_BIN`, `LA_FFMPEG_BIN`, `LA_FFPROBE_BIN`.

## Commands

Every command has detailed `--help` with examples (`la <command> --help`).

| command | what it does |
|---|---|
| `la download <url-or-query>...` | YouTube video URLs, playlist URLs, `yt:<id>` or free-text search → m4a → upload |
| `la upload <file-or-dir>...` | upload local files; non-m4a is converted to AAC m4a (192k) first |
| `la download <url-or-query> --replace <song-id>` | fix a wrong upload: the download replaces that library song's audio + metadata (same id) |
| `la upload <file> --replace <song-id>` | same, from a local file |
| `la requests [list]` | pending song requests (`--status pending\|fulfilled\|all`) |
| `la requests fulfill (--all \| <id>...)` | download + upload each requested song with `request_id` |
| `la requests dismiss <id>...` | dismiss requests |
| `la library [search]` | list/search library songs (`--limit`, `--offset`, `--all`) |
| `la playlist [list]` | playlists you can see (public ones + your private ones) |
| `la playlist create <name> [--private]` | new playlist owned by you (public by default) |
| `la playlist rename <id-or-name> <new name>` | rename |
| `la playlist visibility <id-or-name> public\|private` | share / unshare (owner only) |
| `la playlist delete <id-or-name> --yes` | delete (owner only; songs stay in the library) |
| `la playlist show <id-or-name>` | the playlist's songs (position, library id, YouTube id, entry id) |
| `la playlist add <playlist> <library-id\|yt:ID\|url\|search...>` | add library songs (`--first`, `--allow-duplicates`) |
| `la playlist remove <playlist> <song>...` | remove by position, entry id, library id or `yt:<id>` |
| `la playlist move <playlist> <song> <position>` | reorder |
| `la pull <library-id\|yt:ID>...` | download library songs to this computer (`--search`, `--playlist`, `--all --yes`); see [Pulling songs](#pulling-songs-to-this-computer-la-pull) |
| `la worker [--name NAME]` | run as a downloader: take download jobs from the server, upload the songs; see [Downloader](#downloader-la-worker) |
| `la whoami` | whose token this is (your account name) |
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
la playlist create "Road trip" --private
la download --playlist "Road trip" "Justice - D.A.N.C.E." "Daft Punk - Digital Love"
la upload ~/Music/SomeAlbum/ --playlist "Some Album" --create-playlist
la playlist show "Road trip" --json
la download --allow-similar "Queen - Bohemian Rhapsody (Live Aid)"
la download https://youtu.be/RIGHTVIDEO1 --replace 0b6f3b7e-6b0e-4a59-9a43-6bd1ef3c1f00
la upload fixed.m4a --replace 0b6f3b7e-... --title "Right Title" --artist "Right Artist"
la pull --playlist "Road trip"                  # -> ~/Music/listen-along/Road trip/ + Road trip.m3u8
la pull --search "daft punk" --dir ~/Music/la
la pull --all --yes --json
```

### Downloader (`la worker`)

`la worker` turns a computer at home into a **downloader** for everyone. It
connects out to the server (a WebSocket to `<server>/api/workers/connect`;
nothing listens on your machine, no port forwarding) with your token and waits
for download jobs:

- every new **song request** (someone queued a song the library does not
  have) — the song is then added to the playlist it was requested from;
- the web app's **Download box** (Library → Download): a YouTube video or
  playlist link, a Spotify track link, or a search, optionally into a playlist.

Each job runs the `la download` pipeline (m4a without re-encoding, tags,
cover, duplicate checks) and uploads with the job id, so the server records
which worker did it, whose worker it is and who asked. Progress and the
result are shown live to whoever asked ("downloading on living-room-pc
(Ayşe)"); failures carry the CLI's error code (e.g. `AGE_RESTRICTED`).

Routing is the server's: a job goes to the requester's own idle worker if one
is online, else to any idle worker; with none online it waits ("waiting for a
downloader") and starts when one connects. One job at a time per worker,
`--sleep` seconds between YouTube downloads. Anyone with a token can run one.

```sh
la worker                          # name = this computer's hostname
la worker --name "living-room-pc"  # one name per machine
la worker --install-ytdlp          # fetch / update the official yt-dlp first
la worker --json > events.ndjson   # one JSON event per line on stdout
```

- **Visibility.** Everyone sees the worker as `<name> (<your name>)` (songs
  read "uploaded by living-room-pc (Ayşe)"). Hostname, OS, IP and versions
  are shown to admins only (`/admin` → Downloaders).
- **Connection.** Reconnects by itself (1s, 2s, 4s … 60s, jittered) after a
  network drop or server restart; a running job keeps going and is reported
  after the reconnect (the hello names it). If a worker vanishes mid-job the
  server hands the job to another worker after ~20s. Starting a second
  `la worker` with the same name replaces the first (it exits 1).
- **Stopping.** Ctrl+C (SIGTERM; Ctrl+Break on Windows) finishes the current
  job, reports it and exits 0. A second Ctrl+C kills the download and gives
  the job back to the server (exit 130). yt-dlp/ffmpeg run in their own
  process group (POSIX) / console (Windows), so the first Ctrl+C does not
  reach them.
- **Tools.** If yt-dlp is missing or more than 60 days old, the worker offers
  to download the official standalone binary for your OS from the yt-dlp
  GitHub releases, checked against `SHA2-256SUMS`, into a per-user tools dir
  (`--install-ytdlp` does it without asking; non-interactive runs only warn).
  That copy is then also used by `la download`. `LA_YTDLP_BIN` pins a yt-dlp
  and turns this off. ffmpeg is never installed for you: a missing one exits 6
  with the install command for your OS. Needs **Node.js 22+** (built-in
  WebSocket).

| OS | tools dir | ffmpeg | run it |
|---|---|---|---|
| Linux | `~/.local/share/listen-along/bin` (`$XDG_DATA_HOME`) | `sudo apt install ffmpeg` / `dnf` / `pacman` | `la worker`; keep it running with a systemd user unit or `tmux` |
| macOS | `~/Library/Application Support/listen-along/bin` | `brew install ffmpeg` | `la worker` in Terminal (or a launchd agent) |
| Windows | `%LOCALAPPDATA%\listen-along\bin` | `winget install --id Gyan.FFmpeg`, then open a new terminal | `node cli\bin\la.js worker` in PowerShell / Windows Terminal |

Setup on any OS: install Node.js 22+ (nodejs.org, `brew install node`,
`winget install OpenJS.NodeJS.LTS`), get the repo's `cli/` folder, create a
token on your profile page, then `la config set server …`, `la config set
token …`, `la worker`. `LA_TOOLS_DIR` overrides the tools dir.

For a local try-out without YouTube, `test/fixtures/fake-yt-dlp.js` stands in
for yt-dlp (`LA_YTDLP_BIN=…/fake-yt-dlp.js`, needs the real ffmpeg): it makes
2-second tones tagged from the search text.

#### Run the worker as a service

On Linux, a systemd **user** unit keeps the worker running, restarts it on
failure and starts it on boot. Save as
`~/.config/systemd/user/listen-along-worker.service` (adjust the node and
`la.js` paths and `--name`):

```ini
[Unit]
Description=Listen-Along download worker (la worker)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=LA_YTDLP_BIN=%h/.local/bin/yt-dlp
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node %h/path/to/listen/cli/bin/la.js worker --name my-pc
# SIGTERM to the worker only: it finishes the current job, then exits 0
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=15min
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now listen-along-worker
loginctl enable-linger "$USER"     # start at boot without logging in (may need sudo)
systemctl --user restart listen-along-worker   # or stop / status
journalctl --user -u listen-along-worker -f    # logs
```

Use an absolute node path (`command -v node`; nvm paths work). Setting
`LA_YTDLP_BIN` keeps the worker from prompting to install yt-dlp; otherwise it
only warns when not on a terminal. On macOS use a launchd agent
(`~/Library/LaunchAgents`), on Windows Task Scheduler or NSSM.

### Pulling songs to this computer (`la pull`)

Copies library songs to a local folder. Any token works (no special
permission); no yt-dlp or ffmpeg needed, so it runs the same on Linux, macOS
and Windows.

| form | pulls |
|---|---|
| `la pull <library-id\|yt:ID>...` | those songs (ids from `la library <search>`) |
| `la pull --search "<query>"` | every library match (repeatable); more than 20 → asks on a terminal, otherwise needs `--yes` (exit 2) |
| `la pull --playlist <id-or-name>` | the playlist's songs into `<dir>/<playlist name>/`, plus `<playlist name>.m3u8` in playlist order (repeatable; `--flat`: straight into `--dir`) |
| `la pull --all --yes` | the whole library (paged listing; `--yes` is required) |

Forms combine; a song is fetched once per folder. Options: `--dir DIR`
(default: the `keep-dir` config, `~/Music/listen-along`), `--concurrency N`
(1-8, default 2), `--dry-run`, `--json`, `-y/--yes`.

- **Names** match `la download --keep`: `<Artist> - <Title> [<youtube_id>].m4a`,
  or `[<library id>]` when the song has no YouTube id; the extension follows the
  server's Content-Type (`.mp3`, `.webm`, `.ogg` for the odd non-m4a file).
  Names are made valid on every OS: `< > " / \ | ? *` and control characters are
  replaced or dropped (`a: b` → `a - b`, `AC/DC` → `AC-DC`), no trailing dots or
  spaces, no leading dot, reserved Windows names (`CON`, `NUL`, `COM1`, …) get a
  `_` prefix, NFC, at most 180 bytes before the ` [id]` suffix.
- **Idempotent**: a file that is already there is checked against the song's
  `file_version` (the first 16 hex of the server file's sha256) and skipped
  (`reason: "already downloaded"`) when it matches — also a file with another
  title but the same `[<id>]`, such as a `--keep` copy. A song whose audio was
  replaced on the server no longer matches and is downloaded again over the old
  copy (`updated: true`). Servers without `file_version` are compared by size
  (`HEAD`).
- **Resumable**: a download is written to `<name>.<file_version>.part` and
  renamed only when complete and its hash verified. An interrupted run leaves
  the `.part`; the next run asks for the rest with `Range: bytes=<size>-`
  (`/api/library/:id/file` answers 206) and `resumed: true`. A `.part` that
  turns out wrong is discarded and fetched whole once more.
- **Playlists**: entries that are only YouTube links (not in the library) are
  `skipped` with `reason: "not in library"` and appear as `# missing: …` comments
  in the `.m3u8`. `.m3u8` paths are relative with `/`, UTF-8; it is rewritten
  on every run.
- `--json`: `{dir, summary: {total, pulled, skipped, failed, would_pull?},
  results: [{input, id, status: pulled|skipped|failed|would_pull, title, artist,
  youtube_id, file, bytes, resumed?, updated?, reason?, error?, code?, playlist?}],
  playlists?: [{id, name, dir, m3u8, songs, listed, missing}], aborted?}`.
  Failure codes include `NOT_FOUND`, `INTERRUPTED`, `HASH_MISMATCH`.
- Exit codes: 0 nothing failed, 1 a song failed / playlist not found / cancelled
  at the prompt, 2 usage or more than 20 matches / `--all` without `--yes`
  (`CONFIRM_REQUIRED`), 3/4/5 as below. A rejected token, an unreachable server
  or a full disk aborts the run (partial results printed, `aborted`).

### Duplicates

Before anything is downloaded or uploaded, `la` asks the server whether the
song is already in the library, by three signals:

| signal | when `la` checks | skip `reason` |
|---|---|---|
| same `youtube_id` | library listing at the start (and the server's check) | `already in library` |
| same file bytes (sha256) | after the download / conversion, before the upload | `duplicate_hash` |
| same artist + title, normalized, and duration within ±3s | before a download (search and playlist results: artist/title guessed from the video title or channel) and again before the upload (the file's tags) | `duplicate_metadata` |

Normalization ignores case, accents and Turkish letters (ş, ğ, ı/İ, ç, ö, ü),
upload noise like "(Official Video)", "[HD]", "- Remastered 2011", "feat. …"
credits, "VEVO"/" - Topic" channel suffixes and a leading "Artist - " in the
title; "(Live)", "(Remix)", "- Acoustic" are kept, so versions stay apart.

Every such skip names the existing song in `duplicate_of` (`{id, title,
artist, youtube_id?, match}`) and carries it as `song` (so `--playlist` adds
the existing song). youtube_id and hash matches are exact; a metadata match is
only *probable*: `--allow-similar` uploads it anyway. The server re-checks
every upload (`409` with `code` `already_in_library` / `duplicate_hash` /
`duplicate_metadata`; race-safe, two uploaders cannot both add it), and those
409s become the same skip reasons. A server without the check endpoint is
asked once (404) and then simply gets the upload, as before.

### Replacing a wrong upload (`--replace`)

`la download <one url-or-query> --replace <song-id>` or `la upload <one file>
--replace <song-id>` replaces the audio file **and** the metadata (title,
artist, album, youtube_id, source link, duration; the cover follows the
youtube_id) of an existing library song. The song **keeps its id**, so every
playlist that contains it now plays the new file (open web apps update, and a
listener currently playing it switches to the new file at the same position).
Find the id with `la library <search> --json`. Anyone with a token may replace
(and any approved user in the web app); the server keeps an audit trail
(who, when, old and new youtube_id / source / hash / title / artist) and
deletes the old file only after the new one is in place. No duplicate
pre-checks run, but the server refuses a file or youtube_id that belongs to a
*different* song (`duplicate_hash` / `already_in_library`), the same file
again (`same_file`) or an unknown id (`not_found`) — exit 1. The result has
`status: "replaced"` (`would_replace` with `--dry-run`), `replaced_id`,
`previous: {youtube_id, source_url, title, artist, album, duration_sec,
file_version}` and counts in `summary.replaced`. Not combinable with
`--playlist`, `--allow-similar`, `--no-upload` or `--request-id`.

### Playlists

`la playlist` acts as the token's owner with the web app's rules: a public
playlist is seen and edited (songs, rename) by every user; a private one only
by its owner — to anyone else it does not exist ("not found"). Only the owner
changes visibility or deletes. A **legacy token** (created before tokens had
owners; `la whoami --json` shows `"legacy": true`) sees public playlists only,
creates only public playlists (they have no owner, so every user can edit them
and only an admin can delete them) and can never change visibility or delete.

Playlists are named by **id or exact case-insensitive name** among those you
can see; an ambiguous name fails (exit 1, `AMBIGUOUS`) listing the ids.

`--playlist <id-or-name>` on `la download` / `la upload` adds every song that
ends up in the library — uploaded now, or skipped because it was already there
— to that playlist, one request per song as the batch goes (open web app tabs
update live). Songs already in the playlist are not added twice. A missing
playlist is an error (exit 1, `PLAYLIST_NOT_FOUND`, before anything is
downloaded) unless `--create-playlist` is given, which creates it **public**
(the web app's default) or private with `--private`. Not with `--no-upload`;
with `--dry-run` nothing is created or added. Without `--playlist`, output and
behaviour are exactly as before.

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
  is skipped; a `409` from the server also counts as skipped (see
  [Duplicates](#duplicates) for the hash / metadata checks). With `--keep`,
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
  `{ "summary": {total, uploaded, skipped, failed, ...}, "results": [{input|file, status, youtube_id, source_url?, title, artist, reason?, error?, code?, song?, duplicate_of?}], "aborted"? }`.
  Statuses: `uploaded`, `skipped`, `failed`, `would_download`/`would_upload`
  (`--dry-run`), `downloaded` (`--no-upload`), `dismissed`, `replaced` /
  `would_replace` (`--replace`). Skip reasons: `already in library`,
  `duplicate_hash`, `duplicate_metadata`, `duplicate in this batch`,
  `duplicate (server already has it)` (a 409 from an older server).
  New fields and reasons may be added; existing ones keep their meaning.
  With `--playlist`, the document also has `"playlist": {id, name, visibility,
  created, added, already_in_playlist, failed}` and each uploaded/skipped result
  `playlist_status` (`added` | `already_in_playlist` | `failed`, + `playlist_error`);
  a failed playlist add makes the exit code 1.
- `la playlist` subcommands with `--json`: `list` → `{playlists: [{id, name,
  visibility, owner, is_owner, song_count, created_at}]}`; `create` / `rename` /
  `visibility` → `{playlist}`; `delete` → `{deleted: {id, name}}`; `show` →
  `{playlist, songs: [{position, entry_id, library_id, youtube_id, title, artist,
  duration_sec, url, added_by, added_at, available}]}`; `add` → `{playlist,
  summary, results: [{input, status: added|already_in_playlist|not_in_library|invalid,
  song?, error?}], song_count}`; `remove` → `{playlist, summary: {total, removed,
  failed}, results, song_count}`; `move` → `{playlist, songs}`.

| exit | meaning |
|---|---|
| 0 | success (batch: nothing failed) |
| 1 | failure (batch: at least one item failed; playlist: not found / ambiguous name / not allowed (`FORBIDDEN`) / name taken (`CONFLICT`) / bad value) |
| 2 | usage error (also `la pull` without `--yes` for > 20 matches / `--all`) |
| 3 | not configured (server/token missing) |
| 4 | authentication failed (401/403) |
| 5 | server error or unreachable |
| 6 | missing dependency (yt-dlp / ffmpeg / ffprobe; `la worker`: Node < 22) |
| 130 | `la worker` stopped by a second Ctrl+C (job given back) |

Auth errors, an unreachable server or a missing tool abort a batch; the
partial results are still printed with an `aborted` entry.

## Server API used

All requests send `Authorization: Bearer <token>`.

- `GET /api/me` → `{ name, user: { id, name } | null, token: { label, legacy } }`
  (`user` is null for an old token created before tokens had owners)
- `GET /api/library?q=&limit=&offset=&youtube_id=` → `{ songs: [...], total }`
- `GET /api/library/:id` → `{ song }` (`la pull`)
- `GET|HEAD /api/library/:id/file` → the audio; `Range: bytes=N-` → `206` (`la pull` resume)
- `POST /api/library/check {youtube_id?, sha256?, title?, artist?, duration_sec?, exclude_id?}`
  → `{ duplicate, match, matches: [{reason: already_in_library|duplicate_hash|duplicate_metadata, exact, message, song}] }`
- `POST /api/library/upload` (multipart: `file` m4a, `title`, `artist`,
  `album`, `youtube_id`, `source_url`, `duration_sec`, `request_id`,
  `allow_similar`) → `201 {song}`, `409 {error, code, exact, song}` duplicate,
  `400` bad input
- `POST /api/library/:id/replace` (multipart, same fields) → `{song, previous}`;
  `404 not_found`, `409 {code: same_file|duplicate_hash|already_in_library, song}`
- `GET /api/library/:id/replacements` → `{ replacements: [audit rows] }`
- Song objects also carry `file_version` (changes when the audio is replaced;
  `/api/library/:id/file?v=<file_version>` is cacheable forever) and `replaced_at`.
- Upload records (`la worker`): the upload also sends `job_id` and
  `worker_id`; the server keeps them (if the worker is the token's own) with
  the requester, and songs carry `uploaded_by_worker` and `requested_by`.
- `GET /api/requests?status=pending|fulfilled|all` → `{ requests: [...] }`
- `POST /api/requests/:id/dismiss`
- Worker WebSocket `GET /api/workers/connect` (upgrade). JSON messages:
  worker → `hello {token, name, hostname, platform, arch, os_release,
  cli_version, node_version, ytdlp_version, current_job_id?}`, `pong`,
  `job:progress {job_id, stage, message}`, `job:done {job_id, result:
  {summary, results}}`, `job:release {job_id, reason}`, `drain`; server →
  `welcome {worker, owner, heartbeat_ms}`, `ping`, `job {job: {id, kind,
  input, title, request_id, requested_by, no_playlist}}`. Close codes 4001
  bad token, 4003 replaced, 4005 no database. Full spec:
  `backend/src/workerHub.js`.
- Playlists (also at `/api/lobbies/...`; errors are `{error, code}` with code
  `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `BAD_REQUEST`, `SONG_NOT_FOUND`):
  - `GET /api/playlists` → `{ playlists: [{id, name, visibility, ownerId, ownerName, isOwner, canManage, songCount, ...}] }`
  - `POST /api/playlists {name, visibility}` → `201` playlist
  - `PATCH /api/playlists/:id {name?, visibility?}` → playlist (visibility: owner only, else `403 FORBIDDEN`)
  - `DELETE /api/playlists/:id` (owner only)
  - `GET /api/playlists/:id/songs` → `{ playlist, songs: [...] }`
  - `POST /api/playlists/:id/songs {songs: ["<library uuid>" | "yt:<id>", ...], allow_duplicates?}`
    (max 200) → `{ summary, results, song_count }` (200 even if some are not in the library)
  - `DELETE /api/playlists/:id/songs/:ref` (entry id, library id or `yt:<id>`) → `{ removed, song_count }`
  - `POST /api/playlists/:id/songs/:entryId/move {position}` → `{ songs }`

## Development

```sh
cd cli && npm test
```

Tests use Node's built-in runner against a stub HTTP server implementing the
API above (plus a tiny WebSocket stub of the worker hub, `test/wsStub.js`); the yt-dlp and ffmpeg layers are replaced by fakes (no network).
`test/media-ffmpeg.test.js` runs the real ffmpeg commands on a generated tone
and is skipped when ffmpeg is not installed.

Layout: `bin/la.js` (entry), `src/cli.js` (dispatch, help, global options),
`src/commands/*` (one file per command), `src/pipeline.js` (download/upload
batch logic), `src/pull.js` (`la pull` file naming, skip/resume, .m3u8), `src/playlists.js` (playlist lookup, `--playlist` hook), `src/api.js`, `src/ytdlp.js`, `src/media.js`, `src/config.js`, `src/worker.js`
(worker connection / reconnect / job hand-off), `src/tools.js` (tools dir,
standalone yt-dlp install, version age).
