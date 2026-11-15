# Listen-Along Development Guide

## Database Migrations

**CRITICAL: `CREATE TABLE IF NOT EXISTS` does NOT modify existing tables.**

The schema lives with the area that owns each table, in a `schema.ts` exporting `{ tables, migrations }`:
`backend/src/shared/schema.ts` (`app_settings`), `auth/schema.ts` (`users`, `user_providers`, `api_tokens`,
`user_sessions`), `core/playlists/schema.ts` (`lobbies`, `playlist_pins`), `core/queue/schema.ts` (`queue_songs`),
`core/library/schema.ts` (`songs`, `library_songs`, `library_song_replacements`, `library_song_reports`),
`core/requests/schema.ts` (`song_requests`), `core/jobs/schema.ts` (`download_workers`, `download_jobs`),
`features/social/schema.ts` (`global_chat_messages`). `backend/src/shared/db.ts` runs them from ONE ordered list
(`SCHEMA`, foreign-key order): every area's `tables`, then every area's `migrations`. A new area's file goes into
that list after the areas whose tables it references.

- `tables`: `CREATE TABLE IF NOT EXISTS` only, each must succeed. Nothing else.
- `migrations`: everything else, in the order it must run (indexes, backfills, drops, column changes). A plain
  string's error is ignored (`.catch(() => {})` as before); `{ sql, mustSucceed: true }` stops the database
  start on failure; a function `(db) => …` for a conditional backfill, parameters or its own error handling.

When adding a new column to an existing table, you MUST put it in the `CREATE TABLE` AND append an explicit
migration at the END of that table's ALTERs in the owning `schema.ts` (append, never reorder: an ALTER's position
decides where the column lands on existing databases):

```ts
`ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <column> <type> <default>`,
```

Without this, the column will exist for fresh installs but NOT for existing deployments,
causing silent failures like "column X of relation Y does not exist". This caused #63
where lobby persistence broke entirely on deployed instances. `backend/src/shared/db.test.ts` checks the list
(foreign-key order, no `chat_messages`, no status rewrites); a schema change is proven by `pg_dump --schema-only`
of a fresh database and of a migrated old one.

## Deployment

- Deployed via Dokploy feeding the compose file directly (not the Makefile)
- PostgreSQL uses a Docker named volume (`postgres_data`) that persists across redeploys
- Env vars come from Dokploy CI/CD, not .env files

## Architecture

- Backend: Node.js + Express + Socket.IO (`backend/src/`)
- Frontend: single-page TypeScript, no framework or bundler (`frontend/src`, compiled by `tsc` to `frontend/dist`; see "TypeScript")
- UI is stock Bootstrap 6 (vendored in `frontend/vendor/`) with light theming; read `DESIGN.md` before changing any page or CSS
- Column widths: `frontend/src/shared/layout-rules.ts` (pure, tested) decides when the sidebar is a rail (automatically up to 1100px, `RAIL_MAX`, and above that while expanding it would leave the page column under 616px) and from where the chat docks (1010px); keep its numbers in step with `app.css` (DESIGN.md "Columns and breakpoints"). Queue entries' `artistName` is derived from the library on load (`Queue._loadArtists`), not a column; `title` stays "Title - Artist" for the CLI and Android
- `index.js` is the composition root (about 460 lines, no routes or handlers of its own): reads the config (sign-in
  is fixed at boot), builds the stores and services, builds each area through its `create…({ deps })` factory, mounts
  the routers and registers the socket handlers, then `start()` (database, OIDC boot check, social / listen-along,
  listen) and the shutdown. Areas never require each other: what one needs from another comes in its deps.
  `httpApp.js`: the Express app and HTTP server with what runs before every route (client IP, CORS, JSON, request
  log, static files). HTTP route modules (each a `create…Router({ deps })` mounted by index.js; mount order is semantics):
  `appRoutes.js` (`createInfoRouter`: health, version, changelog, QR, before the library router; `createPageRouter`:
  redirects, SPA views, `/api/app/latest`, `/dashboard`, `/`). Rate limits: `rateLimits.apiLimiter` (3000/min per
  client address) counts each request ONCE where its route is (the route lists it, the library / job router for its
  own paths, a path-scoped `app.use(paths, apiLimiter)` in index.js right before the router serving them, the guard
  for the playlist API before any credential is checked); never `router.use(apiLimiter)` without paths (it charges
  every request that passes by). Not limited: `/health`, `/api/version`, `/api/qr`, the legacy status checks
  (`rate-limits.test.js`),
  `mediaRoutes.js` (`/api/stream`, `/api/covers/:id`), `profileRoutes.js` (`GET|PUT /api/profile`),
  `adminRoutes.js` (dashboard users / statuses / settings / stats / playlist and chat moderation, all `requireAdmin`),
  `authRoutes.js` (the auth guard right after the static files; legacy `/api/auth/register|status`; the
  central-login / dev sign-in round trips, `/api/auth/me`, logout, `/login`, `/api/auth/providers`; it mounts
  the Android app's sign-in, `mobileAuth.js`, on its `router`),
  `playlistRoutes.js` (`/api/playlists` + `/api/lobbies`, songs included; `requireViewer`, `findVisiblePlaylist`;
  returns `ownerNames`, whose cache the socket handlers share).
  `socketServer.js`: the Socket.IO server, the room names (`APP_ROOM`, `userRoom`, `sessionRoom`), the handshake
  (origin check, account, rooms), the central-login re-check of open sockets, and the connection handler: the
  connection's account helpers, then `social` / `listenAlong` `attach`, then each area's `register`, then `disconnect`.
  Socket handler modules (`create…Sockets({ deps })`, whose `register(socket, ctx)` runs per connection):
  `playlistSockets.js` (`lobby:*`, `user:update`, `listener:now-playing`; owns `visibleLobby` / `editableLobby`
  and hands them to the queue handlers), `queueSockets.js` (`queue:*`). `shared/memoryRateLimit.ts`: the 20/min in-memory limits (admin login, `queue:add`).
  `reactions.js`: the cross-area functions (`emitJob`, `queueRequestJob`, `notifyPlaylistsChanged`, `destroyLobby`,
  `accountStatusChanged`, `addLibrarySongToLobby`, `handleLibrarySong{Added,Replaced,DetailsChanged}`,
  `rewriteQueueEntries`, …). Areas get them through their deps and never require each other
- Domain modules: lobby.js, playlistAccess.js, queue.js, covers.js, shared/db.ts (pool + schema runner),
  workerHub.js / downloadJobs.js / jobRoutes.js (downloaders + jobs, see below),
  library.js (music library + upload validation (m4a / Ogg Opus) + legacy cache migration +
  duplicate checks + replace), songMatch.js (normalized "artist|title" key for
  probable duplicates; bump META_KEY_VERSION when changing it — boot recomputes),
  requests.js (song requests), tokens.js (CLI tokens), mobileAuth.js (the
  Android app's sign-in, below), adminAuth.js (/dashboard),
  libraryRoutes.js (library/requests/admin HTTP API), songResolver.js
  (what a user typed -> library song or song request)
- **The server does not download audio.** Songs are uploaded by the
  listen-along CLI (`cli/`) with a Bearer token created on the profile page.
  The library is mixed and stays so: AAC m4a (`.m4a`, `audio/mp4`; every song
  before la 0.3, YouTube 140) and Opus in Ogg (`.opus`, `audio/ogg`; new
  downloads, YouTube 251 stream-copied, m4a when a video has no Opus). The
  format is decided by ffprobe on the content (`classifyUpload`) and kept in
  `library_songs.mime_type` + the file extension; never transcode, never
  convert existing songs. `GET /api/me` lists `upload_formats`; a CLI facing a
  server without it downloads / converts to m4a as before. Anything queued that is not in the library becomes a song
  request; uploads fulfil requests and auto-add the song to the requesting
  playlist. yt-dlp on the server is metadata-only (flat YouTube search, playlist
  listing). See `YTDLP-YOUTUBE.md` before touching song sourcing.
- Duplicates: an upload is refused (409 + `code`) for the same `youtube_id`
  (`already_in_library`), the same bytes (`sha256`, unique: `duplicate_hash`)
  or the same `meta_key` with duration ±3s (`duplicate_metadata`, probable;
  `allow_similar` overrides; serialized by an advisory lock). The CLI asks
  first via `POST /api/library/check`.
- Replace (`POST /api/library/:id/replace`, any valid token or approved web
  user): new audio + metadata under the same song id, audit row in
  `library_song_replacements`, old file deleted after commit; reactions.js
  rewrites queue entries of every playlist holding it and emits
  `library:updated { replaced }` (players reload the new file). Audio
  responses are `no-cache` unless the url has `?v=<file_version>`: never mark
  song urls immutable again, a song's file can change under the same url.
- Editing a song is one dialog ("Replace with…", `frontend/src/features/library/replace-dialog.ts`,
  DESIGN.md). Details only: `PATCH /api/library/:id` (`library.updateDetails`;
  same access as replace, audit row kind `details`, recomputes `meta_key`, no
  duplicate_metadata refusal, as on replace; queues rewritten, `library:updated
  { details }`, the audio plays on). A new YouTube link: `POST /api/jobs/replace`
  (web, approved; rules in `checkReplace`: `same_video`, `already_in_library`,
  `replace_job_active`), a job with `replace_song_id` + `replace_title|artist|album`;
  partial unique index = one active per song. A worker's upload with `job_id`
  goes to `/replace`, where the server forces the job's details and video and
  finishes the job itself; an ordinary upload for that job is refused. A file by
  hand drops a waiting job and is refused (409) while one runs. A details edit
  updates an active job's kept fields. Deleting the song fails its jobs
  (`SONG_DELETED`).
- Broken songs ("needs replacement", `songReports.js`, table
  `library_song_reports`): approved users / owned tokens `POST|DELETE
  /api/library/:id/report` (one open report per user per song, partial unique
  index; only your own can be withdrawn); songs carry `reports` +
  `report_count`; `GET /api/library?reported=1` lists them (CLI/worker can use
  it); `library.replaceSong` resolves open reports in its transaction
  ('replaced'); admins dismiss via `/api/admin/library/reports/:id/dismiss` or
  `/api/admin/library/:songId/reports/dismiss`. Changes emit
  `library:updated { reports }`. Frontend: `song-reports.ts` +
  the reusable `context-menu.ts` (DESIGN.md "Context menu").
- **A song that fails to play** (web): `frontend/src/player/playback-failures.ts` is the
  glue to the page, `playback-failure-flow.ts` the state (injected probe /
  confirm / report / user, so the whole flow is tested without a browser),
  `playback-failure-rules.ts` the pure decisions. The `<audio>` error greys the
  song (in memory, keys `library:<id>` + queue url; cleared when it plays, on
  `library:updated { replaced }`, on `download:status ready`, on reload or
  when the signed-in account changes), `player.next/previous` go past greyed
  songs (`player.setSkip`, `blocked` in `player-queue.ts`; an `unavailable`
  queue entry is tried like any song and greys on its `NOT_IN_LIBRARY`), and
  `STREAK_LIMIT` = 3 failures in a row stop playback.
- **Automatic reports: the SERVER decides, the client only filters.**
  `POST …/report { auto: true }` (column `library_song_reports.auto`, `auto` on
  every report view; no reason, nothing client-sent is stored, never
  overwrites the caller's own report, a manual report makes it `auto` false) is
  stored only if `songVerify.verifyBroken` establishes it itself: **missing** =
  the file is ENOENT and `storageHealth` is healthy (a sample of OTHER songs'
  files: the 10 oldest + 5 either side of the song's upload time, never just
  the newest, since a fresh mount holds only new uploads; needs >= 5 sampled
  and >= 90% present), or **undecodable** = `nice ffmpeg -v error -xerror -i
  <file> -map 0:a:0 -f null -` fails with stderr that blames the input
  (`BAD_INPUT`, also "matches no streams": no audio stream at all) and names
  nothing environmental (`ENVIRONMENT`: memory, I/O, permissions, no such
  file…; but "Operation not permitted" on the DECODER's own lines is a
  decoder's bare -1 for a damaged frame, e.g. AAC's decode_pce, not the
  system), on two runs, the file readable and unchanged
  (size, mtime) after each (one at a time, 4 waiting at most, 60s; only
  certain verdicts are kept, 10 min per file version). Unreadable, killed,
  timed out, no ffmpeg, busy = not established. A file ffmpeg decodes is not
  broken whatever a browser said. The row is inserted by
  `songReports.reportVerified` only while the song still has the checked
  `file_path` (`INSERT … SELECT … FOR SHARE`: a replace during the check must
  not leave a report on the new file); a report the caller already has is
  returned, never inserted. Otherwise: 200 `{ reported: false, code:
  'NOT_CONFIRMED' }` and nothing else in the body, no row. 20 automatic reports per account per 10 min
  (`autoReportLimiter`). Manual reports are untouched. The file routes use the
  same health check: a missing file is ALWAYS a 404 (the Android app skips a
  song on a 404 and goes offline on a 5xx), with `code` `FILE_MISSING`, or
  `STORAGE_UNAVAILABLE` when the sample says the storage is not there (verdict
  cached 3s for the file routes only; the web player treats it as a server
  problem); also `NOT_FOUND` / `NOT_IN_LIBRARY`: keep these codes and the 404. Admin: `POST /api/admin/library/reports/dismiss-automatic`. The
  client's filter (keep it, do not loosen): only `missing` / `undecodable`
  (the whole file fetched `no-store`, complete, <= 64 MB, played muted from a
  `blob:` url; a MediaError alone proves nothing), never offline / 5xx / 401 /
  403 / unknown 404 / deleted song / unsupported format, never from a
  listen-along follower, once per song per page load, not when the song has an
  open report; held until another song plays, then that song's url must be
  served and the held one must still show the same fault, past the cache; a
  streak stop drops it; keys carry a generation so a verdict overtaken by
  played / replaced / cleared / another account is discarded. A report hides
  the song from Radio and the artist pages for everyone.
- **Downloaders ("workers") and download jobs.** `la worker` (cli/src/worker.js,
  commands/worker.js) runs on users' machines and connects OUT over a
  WebSocket to `/api/workers/connect` (raw `ws` server on the HTTP server's
  upgrade event, not Socket.IO; token in the first `hello` message; protocol
  documented at the top of `backend/src/workerHub.js`). `workerHub.js`
  routes queued jobs (`planAssignments`: requester's own idle worker first,
  else any idle worker longest-idle first, else wait; one job per worker;
  replace jobs only to a worker whose hello has capability `replace`, la 0.2.0+:
  an older one would upload a duplicate new song),
  requeues a job whose worker disconnects after `WORKER_REQUEUE_GRACE_MS`
  (default 20s; a reconnecting worker reclaims it via `current_job_id`),
  requeues all `assigned` jobs at boot. Self-update: the image ships cli/;
  `cliRelease.js` bundles it at boot (`GET /api/cli/latest|bundle`, any token),
  the welcome carries `cli_latest`, and la 0.4+ (`update` capability) swaps its
  files while idle and restarts under its supervisor (cli/src/update.js,
  supervisor.js; exit 75 = restart). Older workers get close 4010 with an
  "update" reason once a day (`WORKER_OUTDATED_NUDGE_MS`), never a block.
  `downloadJobs.js` is the store
  (Postgres `download_jobs`, `download_workers`) and the views:
  `publicWorkerView` = name + owner only; `adminWorkerView` adds hostname /
  OS / IP / versions — never send those to non-admins. Jobs come from every
  new song request (reactions.js `queueRequestJob`) and the web Download box
  (`POST /api/jobs`, `jobRoutes.js`, which also serves `/api/workers`,
  `/api/profile/activity` (caller's own only) and `/api/admin/workers|jobs`).
  Uploads carry `job_id` + `worker_id` (`downloadJobs.uploadContext`):
  library_songs records `uploaded_by_worker_id` / `uploaded_by_worker`
  (name snapshot), `upload_job_id`, `requested_by_user_id` / `requested_by`.
  A request job's song reaches its playlist through the request flow; a web
  job with `playlist_id` is added server-side as the requester
  (`addJobSongsToPlaylist`) — workers never learn playlist ids. Live status:
  socket `jobs:update` to the requester's `userRoom`, `workers:update` to
  `APP_ROOM`. Upload percent is plain text in `job:progress.message`, throttled
  by the worker to about 1/s (each one is a DB write + `jobs:update`).
- **Activity log** (the panel's third card: every download job, for every approved
  account; watching only). Row = `downloadJobs.toActivity(row, playlist)`: toPublic's
  field names where they mean the same, but no ids, `input` only for a video link,
  and NOTHING a worker wrote as free text (errors and progress lines hold paths of
  its machine; no pattern catches them all): a failure is its `error_code` (the web
  has a sentence per code, `failureKey` in `activity-rules.ts` + `activity.fail.*`
  in both locales; unknown = "Download failed"), a running job is `stage` +
  upload `percent`, and `progress` is passed on only when it is one of the server's
  own notes (`SERVER_NOTES`: add a new server-written note there). A playlist ONLY
  when the caller passes one the viewer can see now; never `row.playlist_name`
  (that join ignores the viewer). List: `GET /api/activity/downloads` (jobRoutes.js;
  guard default: approved, no tokens; `listActivity`: newest `ACTIVITY_LIMIT` = 60
  plus every active job; empty without a database). Live: `backend/src/features/activity/`, fed by
  `emitJob` in reactions.js, so every job change reaches it (a details edit of a song
  with an active replace job emits it too): `activity:job { job }` to `APP_ROOM`,
  where a private playlist's owner gets the row with the playlist and everyone else
  the same row without (looked up at every emit, as `emitNowPlaying` does), and
  `activity:progress { id, stage, percent }` when nothing else on the row changed,
  at most one per job per 1.5s (`ACTIVITY_PROGRESS_MS`), the latest when the wait
  ends. No DB writes, no new table. `jobs:update` keeps its shape and stays the
  requester's. Frontend: `activity.ts` (rows keep their element, a tick writes one
  text node; refetches on reconnect and on `playlists:changed`, only the latest
  load applies, and a row older by `updated_at` never replaces a newer one), pure
  rules in `activity-rules.ts` (tested), the card shown by `social.ts`
  (`opts.activity`: approved only).
- **Global search** (web only; DESIGN.md "Search"): `frontend/src/features/search/search.ts` (the one field `#app-search`, the app shell's
  top bar at the top of the page column and centred in it, never moved into a page: `body.has-topbar` makes the page
  panel and the library overlay start at `--app-top`; the sidebar and the chat column stay full height from the top gap;
  Ctrl+K / Cmd+K; the page `/search?q=`), pure rules in `frontend/src/features/search/search-rules.ts` (tested in
  `search-rules.test.js`). Library songs: `GET /api/library?sort=relevance` (opt-in; `library.searchRelevant`, order in
  `songSearch.js`, pure and tested: exact / prefix title and artist before loose all-words matches; Turkish-folded in SQL
  with `translate()` and in JS the same way; at most 400 candidates; `searchLimiter` 120/min per account (token owner or
  web user; the client address only without one), only for `sort=relevance`; NUL bytes in `q` are dropped; without `sort=relevance` the list is unchanged).
  Artists and playlists are filtered in the browser from `/api/artists` and the viewer's own `/api/playlists` (so the
  server's visibility rules are the only source; never add a playlist search that skips them). YouTube results only on
  request (`POST /api/jobs/picks { query }`, its 30/min limiter); a pasted link goes to `picks { input }` (+
  `match_library` for Spotify) and is exact. A song played from search is the player context `{ type: 'search', query }`:
  one song, repeated (`contextRepeat`), presence sends no context. The page refetches its songs on `library:updated` only for a change that can touch them
  (`libraryChangeMatters`), debounced, while on screen, and a failed background refetch keeps the results. One-step add target: the editable playlist page on
  screen when the search STARTED (focus, Ctrl+K, the Search place; `pageTarget` / `startTarget` / `keepTarget`, it lasts while
  that search does), else the playlist last PLAYED from (`listen-lastPlayedPlaylist`); only while listed and `canEdit`.
- **Duplicates on the web** = the same library song / YouTube video already in that playlist (another video of the same
  song is not one). Every web add of one library song goes through `addSongToPlaylist` (`add-to-playlist.ts`):
  `POST /api/playlists/:id/songs` refuses it (`already_in_playlist`, its default for every client), the user is asked,
  and only then it is sent with `allow_duplicates`. `POST /api/jobs { picks, playlist_id }` names such songs in
  `already_in_playlist` (additive) and adds them only with the opt-in `allow_duplicates: true`; without it, as before,
  they are skipped. Socket `queue:add` is unchanged (the web no longer uses it to add: the playlist page has no add-song box
  or button; the global search started on that page adds to it).
- **Pick the video** (web only, before a job or request exists): `frontend/src/features/picker/pick-dialog.ts`
  (rules in `pick-rules.ts`, tested; DESIGN.md "Pick the video") asks
  `POST /api/jobs/picks` (jobRoutes.js -> `backend/src/features/picker/`; approved accounts, no tokens,
  `pickLimiter` 30/min per `req.clientIp`, answers cached 10 min, library marking
  never cached): `{ input, match_library? }` is read by `classifyInput` and answers
  `search` (5 results via `ytdlp.searchYoutubeMany`; a Spotify track is "artist - title"),
  `video`, `playlist` (first `MAX_PICKS` = 100) or `library` (nothing to pick:
  an in-library video link, and with `match_library` the same matches as
  songResolver); `{ query }` is always a search (a playlist item's Swap, fetched on
  demand). The choice comes back as `picks: [youtube id]` (`cleanPicks`: 1-100
  valid ids) on `POST /api/jobs` (one `video` job per id, input = the watch URL;
  in-library ones are added to the playlist) or on socket `queue:add`
  (`resolver.resolve({ picks })`: library song or a request with that `youtube_id`). A `playlist` answer carries the
  playlist's `title` (additive; `ytdlp.getPlaylistEntries` returns it on the array). `importPlaylist()` is the same
  checklist with a destination for the search page's import (`withDestination` / `importCounts` in `pick-rules.ts`).
  Titles come from `picker.titles(ids)` (the server's own lookup; oEmbed, a few at a
  time within 10s, for ids it no longer knows), never the client. A picks POST that
  fails part way still dispatches and answers 2xx with `failed: [ids]` + `error`.
  No dedupe: a video with a waiting job gets another (as pasted links always did);
  an open request for it in the same playlist is reused. The dialog closes on any
  route change (`applyRoute`) and when the playlist page closes.
  **Opt-in:** without `picks` both paths behave as before (the downloader searches
  for Download-box text; `queue:add` takes the server's first result), which is
  what the CLI, Android and anything else gets. No worker protocol change: a
  worker classifies `job.input` itself, and a watch URL is a single video.
- Spotify track links supported via `spotify-url-info` page scraping (no API
  credentials needed); title/artist are matched against the library or
  turned into a request
- **Radio** (`/radio`): a station is a list of songs from a rule. `backend/src/features/radio/`
  (`GET /api/stations/:id[/songs]`, lean rows, approved accounts by the guard's
  default, no tokens) holds the rules: `all` = every song without an open report.
  The order is client-side and per opening: `frontend/src/features/radio/radio-order.ts` (pure,
  tested) and `radio.ts`, which renders through `virtual-list.ts`. The player context is `{ type: 'radio', stationId }`;
  `player.setRefill` gives the next round when the list runs out and
  `player.replaceQueue` applies a new order. The order changes only by
  reshuffle, a next round or `library:updated` (`reconcile`, which keeps the
  playing song and puts new songs after it). Presence reports `{ type: 'radio' }`.
  Followers need nothing: `listen:sync` carries the song alone.
- **Artists** (landing shelf, `/artists`, `/artist/<key>`): read-only song lists
  per library artist, nothing stored. `backend/src/features/artists/` (`GET /api/artists`,
  `GET /api/artists/:key/songs`, approved accounts by the guard's default, no
  tokens) puts a song on the page of EVERY artist its credit names, like
  Spotify: `artistCredits.ts` (pure, tested) splits a credit (always on ",",
  feat. / ft. / featuring, vs., lower-case x, ";", " / "; on "&" / "and" / "ve"
  only next to an artist known on their own elsewhere in the library and not
  before "the …" / "Sons"; names in its `BANDS` list never split) and keys each
  artist with `artistNameKey` (computed per request, so nothing to backfill).
  Not `songMatch.normalizeArtist`: that stays primary-artist-only for meta_key.
  Like station `all`, it leaves out songs with an open report. Frontend:
  `artists.ts` (shelf + grid), `artist-page.ts` (song table through
  `virtual-list.ts`), pure rules in `artist-rules.ts` (tested). Player context
  `{ type: 'artist', key, name }`; presence keeps a checked key and the name.
- Android releases: a tag `android-vX.Y.Z` runs `.github/workflows/android-release.yml`
  (signed APK on a GitHub Release; version from the tag; key and backup rules in
  `android/README.md`). The web page `/app` (`frontend/src/features/account/app-page.ts`) offers the latest
  through `GET /api/app/latest` (`backend/src/features/app-release/`: GitHub Releases API, no token, 10 min
  cache + ETag, always 200; only `android-v*` tags count, the repo has old `v2.x` ones).
  Both are open to pending accounts too (`policyFor`: `member`).
- Android app (`android/`, see its README): Kotlin + Compose + Media3, a
  separate client of the HTTP API (no socket, so no live updates). It signs in
  through the central login like the web (`auth/`: Custom Tab, PKCE, the
  server exchanges the code; `backend/src/mobileAuth.js`, CENTRAL-LOGIN.md "The
  Android app") and holds only a `lam_` session token (encrypted), sent as
  `Authorization: Bearer`. Only a 401 with `code: SESSION_ENDED` signs it out
  (`SessionEndedInterceptor`, `ApiException.sessionEnded`): a bare 401, offline
  or a 5xx never does. It has no CLI-token UI any more; an old saved
  `la_` token is deleted at start. Library, playlists (edit mode), broken-song
  reports, background playback (`player/PlaybackService`, a Media3
  `MediaLibraryService`: previous/next only, never seek ±; Android Auto browses
  `player/CarLibrary` over the `player/CarTree` ids; MediaItems never set a mime
  type, ExoPlayer sniffs m4a / Ogg Opus), downloads as plain
  files in `Music/ListenAlong` (the server's bytes, extension from the
  Content-Type, `storage/FileNames`: Opus is saved as `.ogg`;
  MediaStore + WorkManager; after a reinstall
  `storage/FileMatcher` recognises them by name + duration, with the optional
  music access permission). Offline (`net/Connectivity`: a VALIDATED network
  and no failed stream in the last minute): downloaded songs play, streamed
  entries are skipped (`PlayQueue.nextPlayable`); saved playlists and reports
  are read-only. `./dev.sh [--stub]`
  builds, installs and launches; `tools/stub_server.py` stands in for the
  server (its sign-in included), so API or rule changes the app relies on
  belong there too. Tests: `./gradlew :app:testDebugUnitTest`.
  What the app relies on from the server: 404 (skip the song) vs 5xx
  (offline), 401 `SESSION_ENDED` = sign in again and nothing else is, `GET
  /api/me` for its session, the `/auth/mobile/*` contract, and the redirects
  registered at the central login: the https App Link
  `<BASE_URL>/auth/mobile/callback` (release builds on music.etaylan.com;
  `/.well-known/assetlinks.json` names the release key) and, during the
  transition, `com.etaylan.listen:/oauth2redirect` (older apps, debug builds,
  other servers; removing it from the IdP client ends it, with
  `MOBILE_CUSTOM_SCHEME=off` here; then debug builds cannot sign in against the
  production IdP). `auth/AuthFlow.redirectFor` picks one; CENTRAL-LOGIN.md "The redirect".

## Playlists (internally "lobbies")

- Users see **playlists**; the server code, DB table (`lobbies`), socket events
  (`lobby:*`), `lobbyId` fields, DOM ids (`#lobby-view`) and storage keys keep
  the old name (the web's own code says playlist: `features/playlists/playlist.ts`). URLs are `/playlist/<id>`
  and `/playlist/<id>/library`; old `/lobby/...` URLs 301 to them (and the SPA
  rewrites them, `legacyRedirect` in `frontend/src/router.ts`). HTTP API:
  `/api/playlists` (`/api/lobbies` is an alias). It also takes a CLI Bearer
  token (auth guard in authRoutes.js → `requireViewer`): the token acts as its
  owner; a legacy ownerless token sees/edits public playlists only, creates
  only ownerless (public) ones and manages nothing (`viewerCan*` in
  playlistAccess.js). Song endpoints (`/:id/songs`, used by `la playlist` and
  `la download/upload --playlist`) go through `addLibrarySongToLobby` / the
  Queue and emit `queue:update` like the socket handlers.
- Each playlist has an owner (`host_id` = `users.id`, JS `ownerId`) and
  `visibility` 'public' | 'private'. Rules live in `backend/src/playlistAccess.js`:
  public = every logged-in user can see and edit (songs, pin); private =
  owner only, and to everyone else it does not exist (404 / `lobby:not-found`,
  never 403). Only the owner renames (others get 403 on a public playlist),
  switches visibility or deletes. Ownerless (legacy) playlists are always
  public; only admins rename them (admin cookie, `canRename`) or delete them
  (dashboard).
- Enforce on the server in every HTTP route and socket handler that touches a
  playlist or its queue — use `visibleLobby` / `editableLobby` in the socket
  handler and `findVisiblePlaylist` for HTTP. Going private evicts other
  users' sockets (`evictNonOwners`).
- **Sidebar pins are per user**: `playlistPins.js` (Postgres `playlist_pins`, in
  memory without a DB), `PUT|DELETE /api/playlists/:id/pin`, `pinnedByMe` /
  `pinnedAt` in playlist responses. Same 404 rule as everything else: only
  visible playlists are annotated, so a pin never reveals one that went private
  (it comes back if it goes public). A legacy token has no user: 403 on a visible
  playlist. The older shared `lobbies.pinned` (socket `lobby:pin`, field `pinned`)
  still exists on the server but the web no longer sets or shows it; the playlist
  page's pin button is the personal pin.
- The web sidebar (`frontend/src/features/playlists/sidebar.ts`, list in `playlist-store.ts`, search in
  `playlist-filter.ts`) refetches `/api/playlists` on socket `playlists:changed`
  (`notifyPlaylistsChanged` in reactions.js). The signal carries no data; a private
  playlist's changes go only to its owner's `userRoom`. Emit it from anything that
  creates, renames, deletes or changes the visibility of a playlist.
- The page holds the full queue (`queue:update`, about 230 bytes per song) and windows only the rows:
  `frontend/src/shared/virtual-list.ts` (generic, reuse it for any long list), used by `queue.ts`; `queue-edit.ts` drags
  by arithmetic over it. Anything reading rows from the DOM sees only the window: use `shown` / `state.queue`.
  Stats are client-side over the full queue (`playlist-stats.ts`). `/:id/songs` still returns everything.
- There is no per-playlist chat. There is one global chat plus a people panel
  (web: column from 1200px, full-screen `/social` below; `#social-rail` is the opener from 1024px, DESIGN.md)
  (presence + now playing): `backend/src/features/social/`: `social.ts` (socket events, privacy),
  `chat.ts` (store: Postgres `global_chat_messages`, in-memory without a DB;
  keyset pagination), `presence.ts` (online = >= 1 socket, `users.last_seen`,
  one now-playing entry per user, server-timestamped). Never send a raw
  presence entry to a client: `viewNowPlaying()` drops a playlist the
  viewer cannot see.
- **Listen along** = follow a user (not a playlist): `backend/src/features/listen-along/`
  (graph + socket events `listen:*`, attached per connection in socketServer.js) and
  `frontend/src/features/social/listen-along.ts` (drives `player.ts` as its driver). Everyone hears
  the root of their chain (chains collapse); the follow lives in one socket;
  followers get only the song + `/api/library/:id/file`, never the playlist.
  A root going offline (after the presence grace) ends it after the current
  song. Any own playback action of the follower ends it (`player.ts`
  play/pause/seek take `{ keepDriver }` for the driver). The old per-playlist
  follow (`follow:*`) is gone. Do not name a table `chat_messages`: `features/social/schema.ts`
  drops that (old per-playlist chat) on every boot.

## User Identity

- **Central login is the only sign-in** (CENTRAL-LOGIN.md). The old Google /
  GitHub login, its account linking and the stateless `listen_auth` cookie were
  removed; their routes answer 404 (an explicit handler before the guard) and an
  old `listen_auth` cookie is never read, only cleared at sign-in / logout. The
  `users` / `user_providers` rows and columns they wrote stay exactly as they
  are: linking rules b and c read them (never drop or rewrite them). Sign-in is
  fixed at boot, exactly one of: **central login** (`OIDC_ISSUER` +
  `OIDC_CLIENT_ID`; required with `NODE_ENV=production`, together with
  `BASE_URL` (or its fallback `FRONTEND_URL`) and `SESSION_SECRET`, else the
  boot stops; with `NODE_ENV` unset it is still central login) or the **dev sign-in**
  (`INSECURE_DEV_LOGIN=1`, `devLogin.js`, below; refused at boot unless
  `NODE_ENV` is `development` or `test`, and next to `OIDC_*`). Neither = the
  boot stops. `/api/auth/providers` answers `{ central, dev }`; the login page
  has one "Sign in" button. Central login: the owner's authentik over OIDC
  (`oidc.js`: code + PKCE S256 + state + nonce, openid-client v6 with
  `enableNonRepudiationChecks`, redirect URI from `BASE_URL`, never the Host
  header; `aud` exactly the client, no foreign `azp`); a server-side session
  (`oidcSessions.js`, table `user_sessions`: the session cookie's SHA-256, refresh
  token + id_token AES-GCM encrypted via `shared/secretBox.ts`, 30 days; cookies
  `__Host-la_session` / `__Host-la_oidc_flow` when Secure (production), plain
  `la_session` / `la_oidc_flow` on http: names from `oidcConfig.js`) re-checked
  with the refresh token every `OIDC_RECHECK_SECONDS` (3 s timeout; only
  `invalid_grant` or an invalid / foreign id_token ends session + sockets; other
  OAuth errors = kept + `CONFIGURATION PROBLEM` log; IdP silent = kept with
  backoff, ends after `OIDC_MAX_UNVERIFIED_SECONDS`, 24 h). The old
  `listen_auth` cookie is NEVER a session and plays NO part in linking: the
  callback only clears it (do not add an old-cookie link rule back: it hands
  accounts to whoever signs in on that browser). Linking (`oidcLink.js`, `users.oidc_sub` unique): a. sub, b.
  `upstream_identities` vs user_providers / users.provider (earliest of several,
  logged; any match already linked to another sub = refused `link_conflict`,
  never a new account), c. `email_verified === true` and exactly one unlinked
  user with that address from GOOGLE only (legacy GitHub addresses were stored
  unverified), e. new `approved` user unless registrations are closed
  (`shared/settings.ts`, `app_settings.registrations_open`, dashboard switch,
  `GET|PUT /api/admin/settings`; until saved, `REGISTRATIONS_DEFAULT=open|closed`
  decides, then the saved value wins). One `central-login: link rule=<x>
  user=<id> ...` / `central-login: refused ...` log line per sign-in. A denied /
  rejected user is refused at sign-in. `DATABASE_URL` set but no pool = sign-in
  and sessions fail closed (memory only without any database). Accounts created
  by central login have provider `oidc`; the `auth/schema.ts` user_providers backfill must
  skip them.
  Half / broken / missing config stops the boot; an unreachable IdP does not.
  Rollback is redeploying the previous commit (no env switch back to Google /
  GitHub).
- `backend/src/userAuth.js` is the one place that turns a request or a socket
  handshake into a user: `resolve(headers)` / `userIdFor(req)` / `identify(req)`
  (`mode` 'central' | 'dev'); each socket gets `socket.data.userId` (and, with central login,
  `socket.data.sessionId` + the `session:<hash>` room). Never trust a user id or
  name sent by the client.
- **The Android app's session** (`mobileAuth.js`, `mobileTokens.js`;
  CENTRAL-LOGIN.md "The Android app"): the app runs code + PKCE in a Custom
  Tab via `GET /auth/mobile/start` (302 to the IdP with the app's
  `redirect_uri`, one of exactly two: `<BASE_URL>/auth/mobile/callback` or
  `com.etaylan.listen:/oauth2redirect`, the default; the IdP gets
  `idpNonce` = HMAC(HKDF(SESSION_SECRET), redirect + app nonce): a consistency
  check (start and exchange name the same redirect, the nonce came out of
  /start), NOT a secret or a binding to the redirect the IdP used: it is in
  /start's Location header, authentik does not compare redirect_uri at the
  token endpoint and the id_token does not name it. Only removing the scheme
  from the IdP client closes the custom-scheme attack; `MOBILE_CUSTOM_SCHEME=off`
  is its polite server-side companion, tested as "THE LIMIT"), the SERVER exchanges the code at
  `POST /auth/mobile/exchange` (`finishLogin` with that redirect URI and the
  app's state / derived nonce / verifier: the same id_token checks, the same
  `linkCentralIdentity`, a `central-login: ... client=app` line) and stores a
  `user_sessions` row like a cookie session (`create({ prefix: 'lam_' })`:
  the hash covers the prefix, so cookie ids and Bearers never cross). The app
  sends `Bearer lam_...`; `userAuth.who()` resolves it (HTTP only, sockets stay
  cookie-only; no fallback to a cookie when one is sent) through
  `oidcSessions.resolveBearer`, so re-check, expiry and bans
  (`removeForUser`) apply unchanged. `policyFor` is unchanged: it is a user
  session at the account's level. `tokens.hasBearer` is false for `lam_` (so
  "token or signed-in user" routes take it as the user) and `requireToken`
  answers 403 `TOKEN_REQUIRED` (CLI-only routes: upload, check, `/api/cli/*`,
  request dismiss; never a 401). A refused app session is 401 `SESSION_ENDED`
  (`refusal(account, { mobile })`): the app's ONLY signal to sign in again, so
  never answer 401 for an outage. `GET /api/me` with it is answered by
  mobileAuth.js (libraryRoutes.js passes with `next('route')`). Exchange
  codes: `invalid_request`, `signin_failed`, `account_disabled`,
  `registrations_closed`, `link_conflict`, `signin_unavailable`; a code is
  refused the second time before the IdP is asked (released again only after
  a 503 `signin_unavailable`, so a retry works); sign-out
  (`/auth/mobile/logout`) is local (the IdP's browser session stays). Dev
  sign-in: a "Continue as Dev User" page and a stateless signed token, `mode:
  'dev'`, which release builds of the app refuse.
- `users.status` decides access: `approved` = everything; `pending` = chat /
  people panel and own profile only; `denied` / `rejected` = nothing (sockets
  refused). The auth guard (`authRoutes.js`) is deny-by-default (`policyFor()` in
  userAuth.js). Only an admin changes a status — no `schema.ts` may ever rewrite
  statuses on boot (a restart once promoted every pending user). Blocking an
  account (`accountStatusChanged`) disconnects its sockets and, with central
  login, deletes all its sessions; its CLI tokens stop by themselves. The
  central `roles` claim gates nothing (stored with the session for later).
- The CLI (`la`) authenticates with `Authorization: Bearer la_...` tokens
  (`tokens.js`). Each token belongs to a user (`api_tokens.user_id`): approved
  users create / revoke their own on the profile page (`/api/tokens`,
  `tokenRoutes.js`); `/dashboard` lists and revokes all. `req.apiUser` =
  `{ id, name, label, userId, user }`; a token stops working while its owner
  is not approved. Tokens from before ownership have `user_id` NULL ("legacy")
  and still work. Uploads record `library_songs.uploaded_by_user_id` (owner)
  plus the `uploaded_by` display-name snapshot the UI shows.
- Admin (`/dashboard`; `/admin` 301s to it) is a separate `la_admin` cookie
  (`ADMIN_PASSWORD`, `adminAuth.js`), not a user account. The page itself is the
  data-free SPA shell with its own login form (404 without `ADMIN_PASSWORD`);
  all admin data comes from APIs behind `adminAuth.requireAdmin`.
  Frontend: `dashboard.ts` + `dashboard-admin.ts`.
- Client IP (rate limits): `shared/clientIp.ts` trusts only private / loopback proxy
  hops (Traefik) and believes `CF-Connecting-IP` only from Cloudflare's ranges;
  use `req.clientIp`, not `req.ip`. Overrides: `TRUST_PROXY`, `CLOUDFLARE_IPS`.
- Local dev / tests: there is no password login. Either:
  **dev sign-in**: `NODE_ENV=development INSECURE_DEV_LOGIN=1 SESSION_SECRET=dev
  npm run dev` (from `backend/`), then the login page's button, or
  `/auth/dev/login?user=<users.id>&next=/` (no `?user`: a "Dev User" account
  with provider `dev`, made once; no database: the id `dev`). It sets the
  HMAC-signed `la_dev_login` cookie (own label, 30 days); for curl, sign one
  with `node -e "console.log('la_dev_login=' + require('./src/devLogin')
  .signDevToken('dev', '<users.id>'))"`. Without a database any validly signed
  cookie counts as an approved account. Tests: `testServer.js` `cookieFor` is
  that cookie and `startServer()` turns `INSECURE_DEV_LOGIN` on unless the test
  sets `OIDC_*` (never add it to a compose file; production refuses it, tested
  in `auth-guard.test.js`); the server binds `PORT=0` and `listening()` reads the port from its
  "Server running on port N" line (never pick a free port first and bind it later: that races). Or **a fake IdP**: `node src/fakeOidcIssuer.js`
  (prints the `OIDC_*` / `BASE_URL` to start the app with; plain http, so not
  with `NODE_ENV=production`); `central-login.test.js` drives the real flow
  against it, and `testServer.js` `centralSessionCookie(DATABASE_URL,
  '<users.id>')` inserts a `user_sessions` row (prints `la_session=...`).

## TypeScript

The frontend is TypeScript (`frontend/src`). The backend is moving to
TypeScript one area at a time; until an area is converted its files stay
`.js`. The CLI stays JavaScript.

- Configs: `tsconfig.base.json` (shared, `strict`), `backend/tsconfig.json`
  (typecheck only: Node runs `.ts` itself; `allowJs` without `checkJs`, add
  `// @ts-check` per file if wanted; `module: preserve` while CommonJS and ESM
  mix, `nodenext` at the end), `frontend/tsconfig.json` (`frontend/src/**/*.ts`
  compiles to `frontend/dist/`, gitignored, with source maps; `moduleDetection:
  auto` so a file without import / export stays a classic script),
  `frontend/tsconfig.test.json` (typecheck only: the frontend's `*.test.ts`
  with Node's types), and the root `tsconfig.json` that references them.
- The root `package.json` holds only `typescript` and `@types/*` (no
  workspaces: the server's dependencies and the Docker install stay in
  `backend/`). From the repo root: `npm ci`, `npm run typecheck` (`tsc -b`),
  `npm run build` (the frontend), `npm test` (builds the frontend, then the
  backend tests, then `frontend/src/**/*.test.ts`; backend tests serve the
  compiled `/app.js`, so run `npm run build` first when running them from
  `backend/` alone), `npm run dev` (= `make dev`: builds the
  frontend once, then backend watch + `tsc -w`; sets `FRONTEND_PATH` to this
  checkout's `frontend/`). There is no CI: run `typecheck`, `build` and `test` locally.
- Serving (`backend/src/frontendStatic.js`): `<FRONTEND_PATH>/dist` and
  `<FRONTEND_PATH>` are both mounted at the site root, dist first, so
  `frontend/src/shared/x.ts` is `/shared/x.js` (and a compiled file wins over a
  file of the same name in `frontend/`). Same `no-cache` for `.js`, `.css`, `.map`; `/src/**/*.ts` is
  served as text so source maps resolve. A missing `dist/` just falls through.
  `/package.json`, `/tsconfig*.json`, `*.tsbuildinfo` and `/dist/...` answer 404.
- Frontend layout (`frontend/src`): `app.ts`, `router.ts`, `globals.d.ts`,
  `shared/` (state, ui, dom, types, i18n, …), `player/`, `features/<area>/`.
  The URL mirrors the path: `src/shared/state.ts` is `/shared/state.js`, and
  `index.html` loads `/app.js` (compiled `src/app.ts`) plus the two classic
  scripts. Every module is imported statically from `app.ts` (the one
  `import('./shared/state.ts')` re-reads a module already loaded), so a tab
  opened before a deploy keeps working until it reloads: a renamed module is
  never fetched by an old page. Do not add a lazily imported module without
  thinking about old tabs.
- Frontend types: the server's JSON and the socket events are typed once in
  `frontend/src/shared/types.ts` (from the backend's views; the socket is
  `AppSocket`, typed with socket.io-client's types, a root devDependency pinned
  to the version the server bundles). Elements: `byId<T>()` /
  `maybeById<T>()` in `shared/dom.ts` (typed `getElementById`, no runtime
  check) rather than `!` on every lookup.
- Docker: the `frontend` stage of `docker/Dockerfile` runs `npm ci` + `npm run
  build` at the root and only `frontend/dist` is copied into the final image
  (no TypeScript, no root `node_modules`; the backend install stays
  `--production`). `.dockerignore` keeps a local `frontend/dist` out of the
  context.
- Erasable syntax only: no `enum`, `namespace` or constructor parameter
  properties (Node strips types, it does not compile them;
  `erasableSyntaxOnly` reports them). Type-only imports use `import type`.
- Relative imports name the real file: `./x.ts` (the frontend build rewrites
  them to `./x.js`).
- Tests sit next to the code they test. Frontend tests are
  `frontend/src/**/x.test.ts` (ES modules, `.ts` imports, run by Node's type
  stripping from the root `npm test`), so a rule module must stay importable
  in Node: no DOM at import time.
- **Backend, while CommonJS and ES modules mix** (Node 22.18+ type stripping, no build):
  - A converted area is a folder of ES-module `.ts` (`backend/src/features/<name>/`), moved with `git mv` so
    history follows, its tests next to it as `*.test.ts` (plain `node --test` finds them). The folder holding
    converted areas has a `package.json` that is only `{"type": "module"}` (`backend/src/features/`, `shared/`,
    `auth/`, `core/`; the last two hold only their `schema.ts` files so far). Everything under them is ES modules,
    so a file moves there only once converted (never a CommonJS `.js`). Without it Node guesses the format of each `.ts`
    and prints `MODULE_TYPELESS_PACKAGE_JSON` at boot and in tests; with it there is no warning and no flag. It
    goes away when `backend/package.json` becomes `"type": "module"`.
  - Still-CommonJS files `require('./features/<name>/index.ts')` (extension spelled out, always the folder's
    `index.ts`, never its internals; `shared/` has no index: `require('./shared/db.ts')`, one file each).
    Node's `require(esm)` and every `import` share one module instance (checked: module state is not
    duplicated), so a store or singleton may be reached from both. No top-level `await` in
    anything that is `require`d (`ERR_REQUIRE_ASYNC_MODULE`); test files may use it.
  - From `.ts`, import a CommonJS file by its real name (`../../library.js`). Use the default import (`import x
    from '../../library.js'`, the live `module.exports` object) when the code calls `x.f(...)`: tests replace
    properties on such objects, and named imports of CommonJS are a snapshot. Named imports only work for the
    `module.exports = { a, b }` shorthand. Packages: `import pg from 'pg'` then `pg.Client`.
  - An ES module whose functions tests replace (`shared/db.ts`, imported everywhere as `import db from
    './shared/db.ts'` / `require('./shared/db.ts')`): export ONE object as the default AND as `export { db as
    'module.exports' }`. Then `require()` returns that same object (not the module namespace, whose properties
    cannot be assigned), so `db.query = …` in a CommonJS test reaches `.ts` callers that call `db.query(...)`.
    `delete require.cache[…]` does not give a fresh copy of an ES module (the same instance comes back): reset
    its state through its own functions (`db.close()`, then `db.init()`).
  - `import.meta.dirname` for `__dirname`; `createRequire(import.meta.url)` only where a test needs `require.cache`.
  - Each area's `index.ts` exports its `create…({ deps })` factory with a typed deps interface (what the area needs
    from the composition root) and the types of what it sends to clients. Rows and objects used by more than one
    area (users, library songs, playlists, jobs, the Socket.IO server) are in `backend/src/shared/types.ts`
    (which also re-exports `Db` / `Queryable` from `shared/db.ts`), type-only and written from the SQL in the
    areas' `schema.ts` files (pg's parsing: BIGINT is a
    string, TIMESTAMPTZ a Date); change them with the schema. A dependency still in CommonJS gets a small
    structural interface of what the area uses, not `any`; a CommonJS helper imported by `.ts` (e.g.
    `testServer.js`) may get JSDoc `@param` / `@returns` instead. index.js is not typechecked, so a test checks
    that what it passes fits (`export const realServerFits = (io: Io): ActivityIo => io;`). A JavaScript
    function whose inferred type is too loose is typed once where it is imported (`classifyInputJs as (input:
    unknown) => Classified`).
  - Test files: `node:test` / `node:assert/strict` imports; the optional testcontainers package by
    `try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}`; server, socket
    and database JSON may be read through one `type Payload = any` per file. Run one folder's tests with
    `node --test 'src/features/<name>/*.test.ts'` (a directory argument is not searched).
  - Every importer changes in the same commit, and so does every path this file cites. When a test that cannot
    be edited yet still requires an old path, a folder with the old name holds a one-line `index.js`
    re-export, so the move stays a rename in git history; delete it as soon as that test can be edited (none
    is left). A unit test of a moved module that sits inside a bigger test file moves out next to the module
    (the secret box and settings tests left `central-login.test.js`).
  - Schema: an area's tables and migrations go in its folder's `schema.ts` (`{ tables, migrations }`, typed by
    `AreaSchema` / `Migration` from `shared/db.ts` with `import type`, so there is no import cycle at run time),
    listed once in `SCHEMA` in `shared/db.ts`; rules in "Database Migrations" above. An area that has not moved
    yet still owns its `schema.ts` in its target folder (`core/library/`, `auth/`, …), and the code joins it later.
    Moving schema is proven by a byte-identical `pg_dump --schema-only --no-owner` of a fresh database before and
    after, and of an old database migrated by the old and the new code.
  - Preloads stay CommonJS until the final step: `telemetry.js` (+ `telemetryRules.js`) is loaded with `--require`
    before any module is set up. A CommonJS package imported from an ES-module `.ts` (`pg` from `shared/db.ts`)
    is still patched by that preload (checked: pg spans arrive); an ES-module package or file would not be.
  - Left in CommonJS on purpose: `ytdlp.js` (the resolver, the download jobs and `/health` use it) and
    `songReports.js` / `songVerify.js` (library.js and libraryRoutes.js use them inside the library's own
    queries and routes) go to `core/` with the library, not to `features/`. The artist pages import the radio's
    `toStationSong`: the one feature-to-feature import, until that row moves to the library.
- `frontend/src/globals.d.ts` types the classic-script globals (`io`,
  `window.i18n`, `MediaSessionManager`); `shared/i18n.ts` and
  `shared/media-session.ts` are classic scripts (no import / export).
  `window.app` / `window.dashboard*` (handlers named in generated HTML) are
  declared in `app.ts`. `frontend/package.json` is `"type": "module"` so Node
  loads frontend files as ES modules.

## Testing

```bash
cd backend && npm test   # or `npm test` at the repo root (adds frontend tests)
```

Tests use Node's built-in test runner. Some tests need `@testcontainers/postgresql`.

## Local development (Aspire AppHost)

`make up` / `make down` / `make reset` (`scripts/aspire-dev.sh`; README "Local development"). The AppHost is
TypeScript, `aspire/apphost.mts` (Aspire CLI 13.6.4+, no .NET SDK, no C# in the repo); `aspire/aspire.config.json`
pins the SDK and `Aspire.Hosting.PostgreSQL` and fixes the dashboard ports in its `http` profile (dashboard 15260,
OTLP 19260 gRPC / 19261 HTTP, resource service 20260; plain http, so no dev certificate). `aspire/.aspire/` is the
SDK the CLI generates (`aspire restore`), gitignored; `tsc -p aspire/tsconfig.apphost.json --noEmit` typechecks
the AppHost (the root `tsc -b` does not include it).
`aspire/package.json`'s `nodemon` and `tsx` are used by the Aspire CLI itself (it runs the AppHost as `npx --no-install
nodemon --watch . --ext ts,mts --exec 'tsc --noEmit … && tsx apphost.mts'`; without nodemon `make up` fails): keep them.
Its `overrides` lift nodemon's minimatch to ^11.0.1, as `backend/package.json`'s lift testcontainers' archiver-utils glob
to ^14 (minimatch GHSA-g3hv-75wg-m249; no upstream release allows the fix yet; both dev only): drop each override once
nodemon / testcontainers depend on a fixed version.

- Resources: `postgres` (16-alpine, as in production; volume `listen-along-dev-pgdata-<sha256(checkout path)[:10]>`,
  kept across runs) + database `listen`, `pgweb`, `frontend` (`tsc -b frontend -w`), `listen-along` (the server,
  `node --watch --require ./src/telemetry.js src/index.js`, port 3100, not proxied, health `/health` 200,
  `INSECURE_DEV_LOGIN=1`, `ADMIN_PASSWORD=dev-admin`, `SONGS_PATH` / `COVERS_DIR` under `.dev-data/`, OTLP
  http/protobuf to the dashboard), `seed` (after the server is healthy), `worker` (`LISTEN_WORKER=1`), `idp`
  (`LISTEN_AUTH=oidc`: `fakeOidcIssuer.js --port 9400`, then `OIDC_ISSUER` / `OIDC_CLIENT_ID` instead of the dev
  sign-in). `DATABASE_URL` is a `postgres://` URL built with `refExpr` (Aspire's `ConnectionStrings__*` is ADO
  format); the Postgres password is pinned and URL-safe.
- `backend/scripts/dev-seed.js` (plain Node, idempotent, never in the image: `.dockerignore` drops
  `backend/scripts`): users and CLI tokens (SHA-256 of known dev values, as `tokens.js`) and chat straight into
  Postgres; songs (ffmpeg tones, `.m4a` and `.opus`) and playlists through the HTTP API with those tokens, so the
  server's validation and in-memory state apply. Dev User is the row `/auth/dev/login` uses (provider `dev`,
  provider_id `dev`) and gets `oidc_sub = dev-1`, the fake IdP's default sub. When a schema or an API the seed uses
  changes, run `make up` and check `aspire logs seed`.
- `make down` = `aspire stop`, then waits for the AppHost's containers (found by the volume and DCP's
  `creatorProcessId` label) and kills only node / aspire-managed processes whose cwd is this checkout and whose
  command line is one of the AppHost's (never under `.claude/`).

## OpenTelemetry

`backend/src/telemetry.js` is a preload (`--require`), never required by the app; OFF unless an OTLP endpoint
variable is set (`telemetryRules.telemetryConfig`): then nothing from `@opentelemetry` is loaded. Production enables
it with `NODE_OPTIONS=--require=/app/src/telemetry.js` + `OTEL_EXPORTER_OTLP_ENDPOINT` (no image change). OTLP over
HTTP only (`http/protobuf` default, `http/json`); gRPC is refused. OpenTelemetry JS 3.x (`@opentelemetry/sdk-trace`
3.x, experimental packages 0.301.x; pinned exactly, moved as a set): the SDK no longer reads `OTEL_BSP_*`,
`OTEL_TRACES_SAMPLER` or `OTEL_METRIC_EXPORT_INTERVAL` itself, `telemetryRules` does; `BatchSpanProcessor` takes
`{ exporter, … }`.
- Traces: http (server + client), Express only for the route (`ignoreLayersType` all: no layer spans), pg
  (`requireParentSpan`, no connect spans, `enhancedDatabaseReporting` off), undici (fetch). Metrics: http + pg pool
  + runtime-node. No Socket.IO instrumentation.
- Every span leaves through `SanitizingExporter` -> `telemetryRules.sanitizeAttributes` / `sanitizeSpanName`:
  drops query strings, headers, bodies, client addresses, SQL parameter values and quoted literals; a route
  registered for several paths (`['/api/playlists/:id', '/api/lobbies/:id']`) is reduced to the one that matched
  (`pickRoute`; the HTTP metric keeps the joined template). Add a rule there, with a test, before recording
  anything new. `ignoreIncomingPath`: `/health`, static files, `/socket.io/`.
- Log correlation: console methods get ` trace_id=… span_id=…` appended while a sampled span is active
  (`shared/logger.ts` wraps console after the preload, so its prefix stays first).
- Shutdown: on SIGTERM / SIGINT the flush starts at once and the app's own `process.exit` waits for it (2 s
  at most); a process without its own handler still ends on the signal. `telemetry.test.js` checks all of it,
  including that nothing is loaded without an endpoint.
- ESM switch: `--require` cannot patch ES modules. Then `node --import ./src/telemetry.ts`, which first calls
  `module.register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)`; `NODE_OPTIONS=--import=…`.
