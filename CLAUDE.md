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
- `index.js` is the main server (~1700 lines, handles all HTTP routes + socket events)
- Domain modules: lobby.js, queue.js, playback.js, chat.js, covers.js, db.js,
  library.js (music library + m4a validation + legacy cache migration),
  requests.js (song requests), tokens.js (CLI tokens), adminAuth.js (/admin),
  libraryRoutes.js (library/requests/admin HTTP API), songResolver.js
  (what a user typed -> library song or song request)
- **The server does not download audio.** Songs are uploaded as m4a by the
  listen-along CLI (`cli/`) with a Bearer token created on `/admin`
  (`ADMIN_PASSWORD`). Anything queued that is not in the library becomes a song
  request; uploads fulfil requests and auto-add the song to the requesting
  lobby. yt-dlp on the server is metadata-only (flat YouTube search, playlist
  listing). See `YTDLP-YOUTUBE.md` before touching song sourcing.
- Spotify track links supported via `spotify-url-info` page scraping (no API
  credentials needed); title/artist are matched against the library or
  turned into a request

## User Identity

- No auth system yet. Users identified by random localStorage ID (`user_` + 9 chars)
- Future: Google OAuth login planned (see roadmap)

## Testing

```bash
cd backend && npm test
```

Tests use Node's built-in test runner. Some tests need `@testcontainers/postgresql`.
