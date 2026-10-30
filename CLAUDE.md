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
- `index.js` is the main server (~1700 lines, handles all HTTP routes + socket events)
- Domain modules: lobby.js, playlistAccess.js, queue.js, playback.js, covers.js, db.js,
  library.js (music library + m4a validation + legacy cache migration +
  duplicate checks + replace), songMatch.js (normalized "artist|title" key for
  probable duplicates; bump META_KEY_VERSION when changing it — boot recomputes),
  requests.js (song requests), tokens.js (CLI tokens), adminAuth.js (/admin),
  libraryRoutes.js (library/requests/admin HTTP API), songResolver.js
  (what a user typed -> library song or song request)
- **The server does not download audio.** Songs are uploaded as m4a by the
  listen-along CLI (`cli/`) with a Bearer token created on `/admin`
  (`ADMIN_PASSWORD`). Anything queued that is not in the library becomes a song
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
- Spotify track links supported via `spotify-url-info` page scraping (no API
  credentials needed); title/artist are matched against the library or
  turned into a request

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
  public = every logged-in user can see and edit (songs, rename, pin); private =
  owner only, and to everyone else it does not exist (404 / `lobby:not-found`,
  never 403). Only the owner switches visibility or deletes. Ownerless (legacy)
  playlists are always public; only admins delete them (dashboard).
- Enforce on the server in every HTTP route and socket handler that touches a
  playlist or its queue — use `visibleLobby` / `editableLobby` in the socket
  handler and `findVisiblePlaylist` for HTTP. Going private evicts other
  users' sockets (`evictNonOwners`).
- There is no per-playlist chat. There is one global chat plus a people panel
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
  `tokenRoutes.js`); `/admin` lists and revokes all. `req.apiUser` =
  `{ id, name, label, userId, user }`; a token stops working while its owner
  is not approved. Tokens from before ownership have `user_id` NULL ("legacy")
  and still work. Uploads record `library_songs.uploaded_by_user_id` (owner)
  plus the `uploaded_by` display-name snapshot the UI shows.
- Admin (`/admin`, `/dashboard`) is a separate `la_admin` cookie
  (`ADMIN_PASSWORD`, `adminAuth.js`), not a user account.
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
