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
  library.js (music library + m4a validation + legacy cache migration),
  requests.js (song requests), tokens.js (CLI tokens), adminAuth.js (/admin),
  libraryRoutes.js (library/requests/admin HTTP API), songResolver.js
  (what a user typed -> library song or song request)
- **The server does not download audio.** Songs are uploaded as m4a by the
  listen-along CLI (`cli/`) with a Bearer token created on `/admin`
  (`ADMIN_PASSWORD`). Anything queued that is not in the library becomes a song
  request; uploads fulfil requests and auto-add the song to the requesting
  playlist. yt-dlp on the server is metadata-only (flat YouTube search, playlist
  listing). See `YTDLP-YOUTUBE.md` before touching song sourcing.
- Spotify track links supported via `spotify-url-info` page scraping (no API
  credentials needed); title/artist are matched against the library or
  turned into a request

## Playlists (internally "lobbies")

- Users see **playlists**; the code, DB table (`lobbies`), socket events
  (`lobby:*`) and `lobbyId` fields keep the old name. URLs are `/playlist/<id>`
  and `/playlist/<id>/library`; old `/lobby/...` URLs 301 to them (and the SPA
  rewrites them, `legacyRedirect` in `frontend/router.js`). HTTP API:
  `/api/playlists` (`/api/lobbies` is an alias).
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
- There is no per-playlist chat (removed; a global chat is planned).

## User Identity

- OAuth (Google/GitHub) sets a signed `listen_auth` cookie holding `users.id`;
  `getAuthUserId(req)` reads it, and each socket reads it from its handshake
  (`socket.data.userId`). Never trust a user id sent by the client.
- Not logged in = no playlist access. The legacy localStorage id (`user_` + 9
  chars) is only used for the old approval check.
- In-memory dev mode (no Postgres) cannot log in; to try the UI, set
  `SESSION_SECRET`, forge a `listen_auth` cookie with the same HMAC as
  `createAuthToken`, and mock `/api/auth/me` (see playlist-permissions.test.js).

## Testing

```bash
cd backend && npm test
```

Tests use Node's built-in test runner. Some tests need `@testcontainers/postgresql`.
