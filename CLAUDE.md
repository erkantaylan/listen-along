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
- Domain modules: lobby.js, queue.js, playback.js, chat.js, covers.js, downloader.js, playlist.js, db.js
- Song downloads via yt-dlp + ffmpeg, cached in `songs/` directory
- Spotify support via Client Credentials flow (search YouTube for playback)

## User Identity

- No auth system yet. Users identified by random localStorage ID (`user_` + 9 chars)
- Playlists are scoped to this ephemeral userId
- Future: Google OAuth login planned (see roadmap)

## Testing

```bash
cd backend && npm test
```

Tests use Node's built-in test runner. Some tests need `@testcontainers/postgresql`.
