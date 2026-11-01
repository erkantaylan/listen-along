# Listen-Along Development Guide

## Database Migrations

**CRITICAL: `CREATE TABLE IF NOT EXISTS` does NOT modify existing tables.**

When adding a new column to an existing table, you MUST add an explicit migration
in `backend/src/db.js` in the migrations section (after `createTables()`):

```js
await pool.query(`
  ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <column> <type> <default>
`).catch(() => {});
```

Without this, the column will exist for fresh installs but NOT for existing deployments,
causing silent failures like "column X of relation Y does not exist". This caused #63
where lobby persistence broke entirely on deployed instances.

## Deployment

- Deployed via Dokploy feeding the compose file directly (not the Makefile)
- PostgreSQL uses a Docker named volume (`postgres_data`) that persists across redeploys
- Env vars come from Dokploy CI/CD, not .env files

## Architecture

- Backend: Node.js + Express + Socket.IO (`backend/src/`)
- Frontend: Vanilla JS, single-page (`frontend/`)
- UI is stock Bootstrap 6 (vendored in `frontend/vendor/`) with light theming; read `DESIGN.md` before changing any page or CSS
- Column widths: `frontend/layout-rules.js` (pure, tested) decides when the sidebar is a rail and from where the chat docks; keep its numbers in step with `app.css` (DESIGN.md "Columns and breakpoints"). Queue entries' `artistName` is derived from the library on load (`Queue._loadArtists`), not a column; `title` stays "Title - Artist" for the CLI and Android
- `index.js` is the main server (~1700 lines, handles all HTTP routes + socket events)
- Domain modules: lobby.js, playlistAccess.js, queue.js, covers.js, db.js,
  workerHub.js / downloadJobs.js / jobRoutes.js (downloaders + jobs, see below),
  library.js (music library + m4a validation + legacy cache migration +
  duplicate checks + replace), songMatch.js (normalized "artist|title" key for
  probable duplicates; bump META_KEY_VERSION when changing it — boot recomputes),
  requests.js (song requests), tokens.js (CLI tokens), adminAuth.js (/dashboard),
  libraryRoutes.js (library/requests/admin HTTP API), songResolver.js
  (what a user typed -> library song or song request)
- **The server does not download audio.** Songs are uploaded as m4a by the
  listen-along CLI (`cli/`) with a Bearer token created on the profile page. Anything queued that is not in the library becomes a song
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
  `library_song_replacements`, old file deleted after commit; index.js
  rewrites queue entries of every playlist holding it and emits
  `library:updated { replaced }` (players reload the new file). Audio
  responses are `no-cache` unless the url has `?v=<file_version>`: never mark
  song urls immutable again, a song's file can change under the same url.
- Broken songs ("needs replacement", `songReports.js`, table
  `library_song_reports`): approved users / owned tokens `POST|DELETE
  /api/library/:id/report` (one open report per user per song, partial unique
  index; only your own can be withdrawn); songs carry `reports` +
  `report_count`; `GET /api/library?reported=1` lists them (CLI/worker can use
  it); `library.replaceSong` resolves open reports in its transaction
  ('replaced'); admins dismiss via `/api/admin/library/reports/:id/dismiss` or
  `/api/admin/library/:songId/reports/dismiss`. Changes emit
  `library:updated { reports }`. Frontend: `song-reports.js` +
  the reusable `context-menu.js` (DESIGN.md "Context menu").
- **Downloaders ("workers") and download jobs.** `la worker` (cli/src/worker.js,
  commands/worker.js) runs on users' machines and connects OUT over a
  WebSocket to `/api/workers/connect` (raw `ws` server on the HTTP server's
  upgrade event, not Socket.IO; token in the first `hello` message; protocol
  documented at the top of `backend/src/workerHub.js`). `workerHub.js`
  routes queued jobs (`planAssignments`: requester's own idle worker first,
  else any idle worker longest-idle first, else wait; one job per worker),
  requeues a job whose worker disconnects after `WORKER_REQUEUE_GRACE_MS`
  (default 20s; a reconnecting worker reclaims it via `current_job_id`),
  requeues all `assigned` jobs at boot. `downloadJobs.js` is the store
  (Postgres `download_jobs`, `download_workers`) and the views:
  `publicWorkerView` = name + owner only; `adminWorkerView` adds hostname /
  OS / IP / versions — never send those to non-admins. Jobs come from every
  new song request (index.js `queueRequestJob`) and the web Download box
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
- Spotify track links supported via `spotify-url-info` page scraping (no API
  credentials needed); title/artist are matched against the library or
  turned into a request
- **Radio** (`/radio`): a station is a list of songs from a rule. `stations.js`
  (`GET /api/stations/:id[/songs]`, lean rows, approved accounts by the guard's
  default, no tokens) holds the rules: `all` = every song without an open report.
  The order is client-side and per opening: `frontend/radio-order.js` (pure,
  tested) and `radio.js`, which renders through `virtual-list.js`. The player context is `{ type: 'radio', stationId }`;
  `player.setRefill` gives the next round when the list runs out and
  `player.replaceQueue` applies a new order. The order changes only by
  reshuffle, a next round or `library:updated` (`reconcile`, which keeps the
  playing song and puts new songs after it). Presence reports `{ type: 'radio' }`.
  Followers need nothing: `listen:sync` carries the song alone.
- Android app (`android/`, see its README): Kotlin + Compose + Media3, a
  separate client of the HTTP API with a CLI Bearer token (stored encrypted, no
  socket, so no live updates). Library, playlists (edit mode), broken-song
  reports, background playback (`player/PlaybackService`), downloads as plain
  files in `Music/ListenAlong` (MediaStore + WorkManager; after a reinstall
  `storage/FileMatcher` recognises them by name + duration, with the optional
  music access permission). Offline: downloaded
  songs play; saved playlists and reports are read-only. `./dev.sh [--stub]`
  builds, installs and launches; `tools/stub_server.py` stands in for the
  server, so API or rule changes the app relies on belong there too. Tests:
  `./gradlew :app:testDebugUnitTest`.

## Playlists (internally "lobbies")

- Users see **playlists**; the code, DB table (`lobbies`), socket events
  (`lobby:*`) and `lobbyId` fields keep the old name. URLs are `/playlist/<id>`
  and `/playlist/<id>/library`; old `/lobby/...` URLs 301 to them (and the SPA
  rewrites them, `legacyRedirect` in `frontend/router.js`). HTTP API:
  `/api/playlists` (`/api/lobbies` is an alias). It also takes a CLI Bearer
  token (auth guard in index.js → `requireViewer`): the token acts as its
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
- The web sidebar (`frontend/sidebar.js`, list in `playlist-store.js`, search in
  `playlist-filter.js`) refetches `/api/playlists` on socket `playlists:changed`
  (`notifyPlaylistsChanged` in index.js). The signal carries no data; a private
  playlist's changes go only to its owner's `userRoom`. Emit it from anything that
  creates, renames, deletes or changes the visibility of a playlist.
- The page holds the full queue (`queue:update`, about 230 bytes per song) and windows only the rows:
  `frontend/virtual-list.js` (generic, reuse it for any long list), used by `queue.js`; `queue-edit.js` drags
  by arithmetic over it. Anything reading rows from the DOM sees only the window: use `shown` / `state.queue`.
  Stats are client-side over the full queue (`playlist-stats.js`). `/:id/songs` still returns everything.
- There is no per-playlist chat. There is one global chat plus a people panel
  (web: column from 1200px, full-screen `/social` below; `#social-rail` is the opener from 1024px, DESIGN.md)
  (presence + now playing): `backend/src/social.js` (socket events, privacy),
  `chat.js` (store: Postgres `global_chat_messages`, in-memory without a DB;
  keyset pagination), `presence.js` (online = >= 1 socket, `users.last_seen`,
  one now-playing entry per user, server-timestamped). Never send a raw
  presence entry to a client: `viewNowPlaying()` drops a playlist the
  viewer cannot see.
- **Listen along** = follow a user (not a playlist): `backend/src/listenAlong.js`
  (graph + socket events `listen:*`, wired in index.js) and
  `frontend/listen-along.js` (drives `player.js` as its driver). Everyone hears
  the root of their chain (chains collapse); the follow lives in one socket;
  followers get only the song + `/api/library/:id/file`, never the playlist.
  A root going offline (after the presence grace) ends it after the current
  song. Any own playback action of the follower ends it (`player.js`
  play/pause/seek take `{ keepDriver }` for the driver). The old per-playlist
  follow (`follow:*`) is gone. Do not name a table `chat_messages`: db.js drops that
  (old per-playlist chat) on every boot.

## User Identity

- Users are OAuth accounts (Google / GitHub, `users` + `user_providers`). Login
  sets an HMAC-signed `listen_auth` cookie holding `users.id` (30 days,
  `SESSION_SECRET`); `backend/src/userAuth.js` verifies it, and each socket
  reads it from its handshake (`socket.data.userId`). Never trust a user id or
  name sent by the client.
- `users.status` decides access: `approved` = everything; `pending` = chat /
  people panel and own profile only; `denied` / `rejected` = nothing (sockets
  refused). The auth guard in `index.js` is deny-by-default (`policyFor()` in
  userAuth.js). Only an admin changes a status — db.js must never rewrite
  statuses on boot (a restart once promoted every pending user).
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
  Frontend: `dashboard.js` + `dashboard-admin.js`.
- Client IP (rate limits): `clientIp.js` trusts only private / loopback proxy
  hops (Traefik) and believes `CF-Connecting-IP` only from Cloudflare's ranges;
  use `req.clientIp`, not `req.ip`. Overrides: `TRUST_PROXY`, `CLOUDFLARE_IPS`.
- Local dev / tests: there is no password login. Start the server with a known
  `SESSION_SECRET` and Postgres, insert a `users` row, and sign a cookie with
  the same secret, e.g. `node -e "console.log(require('./src/userAuth')
  .createUserAuth({secret:'dev',db:null}).createToken('<users.id>'))"` → set it
  as `listen_auth` (see `testServer.js` `cookieFor`). Without a database any
  validly signed cookie counts as an approved account.

## Testing

```bash
cd backend && npm test
```

Tests use Node's built-in test runner. Some tests need `@testcontainers/postgresql`.
