// Playlists (table `playlists`, renamed from `lobbies` in `before`), the per-user
// sidebar pins and the per-user sidebar folders (playlist.ts, playlistPins.ts,
// folders.ts). Run by shared/db.ts, in the order of its SCHEMA list.
import type { Migration } from '../../shared/db.ts';

// Before any table is created (shared/db.ts runs every area's `before` first).
// One DO block each: atomic, so a boot that dies half-way changes nothing.
export const before: readonly string[] = [
  // The personal-playlist feature (removed long ago) left the tables
  // playlist_songs and playlists, and every boot used to drop both BY NAME. Only
  // those legacy tables go now: a `playlists` with host_id is this app's own
  // (the playlists table, see below) and is never dropped.
  // Then a rollback guard: older images still run
  // `DROP TABLE IF EXISTS playlist_songs, playlists CASCADE` on every boot.
  // A VIEW named playlist_songs makes that whole statement fail (DROP TABLE
  // refuses a view, even with IF EXISTS), and an older image ignores that
  // error, so it can never drop the playlists table. Keep the view while an
  // image with that DROP may still be started against this database.
  `
    DO $legacy$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = 'playlist_songs' AND c.relkind = 'r') THEN
        DROP TABLE public.playlist_songs CASCADE;
      END IF;
      IF to_regclass('public.playlists') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'playlists' AND column_name = 'host_id'
      ) THEN
        DROP TABLE public.playlists CASCADE;
      END IF;
      IF to_regclass('public.playlist_songs') IS NULL THEN
        CREATE VIEW public.playlist_songs AS SELECT NULL::integer AS rollback_guard WHERE false;
        COMMENT ON VIEW public.playlist_songs IS 'Rollback guard: makes the DROP TABLE of older images fail (core/playlists/schema.ts)';
      END IF;
    END
    $legacy$
  `,
  // The lobby -> playlist rename, in place (never drop and recreate): the
  // table lobbies becomes playlists and every lobby_id column playlist_id, with
  // their constraints and indexes, in one statement. Runs once: afterwards (and
  // on a fresh database) there is no lobbies table and no lobby_id column, so
  // it changes nothing. A `lobbies` next to `playlists` is what an older image
  // leaves when it is started against the renamed database (it creates an
  // empty lobbies, then fails on the renamed columns and runs without a
  // database): empty, it is dropped; with rows, the boot stops (CLAUDE.md,
  // "The lobby -> playlist rename (and rolling it back)").
  `
    DO $rename$
    DECLARE t text;
    BEGIN
      IF to_regclass('public.lobbies') IS NOT NULL AND to_regclass('public.playlists') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.lobbies) THEN
          RAISE EXCEPTION 'lobbies and playlists both exist and lobbies holds rows: see CLAUDE.md "The lobby -> playlist rename (and rolling it back)"';
        END IF;
        DROP TABLE public.lobbies;
      END IF;
      IF to_regclass('public.lobbies') IS NOT NULL THEN
        ALTER TABLE public.lobbies RENAME TO playlists;
      END IF;
      IF to_regclass('public.playlists') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.playlists') AND conname = 'lobbies_pkey'
      ) THEN
        ALTER TABLE public.playlists RENAME CONSTRAINT lobbies_pkey TO playlists_pkey;
      END IF;
      IF to_regclass('public.idx_lobbies_last_activity') IS NOT NULL THEN
        ALTER INDEX public.idx_lobbies_last_activity RENAME TO idx_playlists_last_activity;
      END IF;
      FOREACH t IN ARRAY ARRAY['queue_songs', 'playlist_pins', 'playlist_folder_items', 'song_requests'] LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'lobby_id')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'playlist_id') THEN
          EXECUTE format('ALTER TABLE public.%I RENAME COLUMN lobby_id TO playlist_id', t);
        END IF;
        IF to_regclass('public.' || t) IS NOT NULL AND EXISTS (
          SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.' || t) AND conname = t || '_lobby_id_fkey'
        ) THEN
          EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', t, t || '_lobby_id_fkey', t || '_playlist_id_fkey');
        END IF;
      END LOOP;
      IF to_regclass('public.idx_queue_songs_lobby') IS NOT NULL THEN
        ALTER INDEX public.idx_queue_songs_lobby RENAME TO idx_queue_songs_playlist;
      END IF;
      IF to_regclass('public.idx_playlist_pins_lobby') IS NOT NULL THEN
        ALTER INDEX public.idx_playlist_pins_lobby RENAME TO idx_playlist_pins_playlist;
      END IF;
      IF to_regclass('public.idx_playlist_folder_items_lobby') IS NOT NULL THEN
        ALTER INDEX public.idx_playlist_folder_items_lobby RENAME TO idx_playlist_folder_items_playlist;
      END IF;
    END
    $rename$
  `,
];

export const tables: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS playlists (
      id VARCHAR(8) PRIMARY KEY,
      host_id VARCHAR(255),
      name VARCHAR(50),
      visibility VARCHAR(10) NOT NULL DEFAULT 'public',
      created_at BIGINT NOT NULL,
      last_activity BIGINT NOT NULL
    )
  `,
  // Per-user playlist pins (core/playlists/playlistPins.ts). Goes with both the user and the
  // playlist. Unrelated to the shared playlists.pinned column.
  `
    CREATE TABLE IF NOT EXISTS playlist_pins (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      playlist_id VARCHAR(8) NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      pinned_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, playlist_id)
    )
  `,
  // Per-user sidebar folders (folders.ts). One level: a folder holds
  // playlists. Goes with the user. (id, user_id) is unique so a filing row can
  // name its folder AND its user, and so never point at another user's folder.
  `
    CREATE TABLE IF NOT EXISTS playlist_folders (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(50) NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      UNIQUE (id, user_id)
    )
  `,
  // Which folder a playlist is in, per user: at most one (the primary key).
  // Goes with the user, the playlist (deleted) and the folder (deleted: the
  // playlist is back at the top level). A playlist that went private keeps its
  // row, hidden by the API, as a pin does.
  `
    CREATE TABLE IF NOT EXISTS playlist_folder_items (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      playlist_id VARCHAR(8) NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      folder_id UUID NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, playlist_id),
      FOREIGN KEY (folder_id, user_id) REFERENCES playlist_folders(id, user_id) ON DELETE CASCADE
    )
  `,
];

export const migrations: readonly Migration[] = [
  // (The personal-playlist feature's tables: see `before`.)
  { sql: `CREATE INDEX IF NOT EXISTS idx_playlists_last_activity ON playlists(last_activity);`, mustSucceed: true },

  // Migrations for existing databases
  `
    ALTER TABLE playlists ADD COLUMN IF NOT EXISTS name VARCHAR(50)
  `,

  `
    ALTER TABLE playlists ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE
  `,

  // "Jam" (synchronized) lobbies were removed: every lobby is a shared queue
  // each listener plays at their own pace. Drop the per-lobby mode, the shared
  // queue cursor and the server-side playback state so existing deployments
  // load every lobby (including former Jam ones) the same way.
  `ALTER TABLE playlists DROP COLUMN IF EXISTS listening_mode`,
  `ALTER TABLE playlists DROP COLUMN IF EXISTS current_index`,
  `DROP TABLE IF EXISTS playback_state`,

  // Playlists (lobbies) are 'public' or 'private' (owner only). Replaces the
  // earlier is_public flag: a lobby that was already private AND has an owner
  // stays private, everything else (including ownerless rows, which can never
  // be private) becomes public. Idempotent: the backfill only runs while the
  // old column still exists, and drops it afterwards.
  `
    ALTER TABLE playlists ADD COLUMN IF NOT EXISTS visibility VARCHAR(10) NOT NULL DEFAULT 'public'
  `,
  async (db) => {
    const legacyVisibility = await db.query(`
      SELECT 1 FROM information_schema.columns WHERE table_name = 'playlists' AND column_name = 'is_public'
    `).catch(() => ({ rows: [] }));
    if (legacyVisibility.rows.length > 0) {
      await db.query(`
        UPDATE playlists SET visibility = 'private' WHERE is_public = FALSE AND host_id IS NOT NULL
      `);
      await db.query(`ALTER TABLE playlists DROP COLUMN IF EXISTS is_public`);
    }
  },

  { sql: `CREATE INDEX IF NOT EXISTS idx_playlist_pins_playlist ON playlist_pins(playlist_id)`, mustSucceed: true },

  // Playlist folders: a user's folders, a folder's playlists, and the cascade from a deleted playlist.
  { sql: `CREATE INDEX IF NOT EXISTS idx_playlist_folders_user ON playlist_folders(user_id)`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_playlist_folder_items_folder ON playlist_folder_items(folder_id)`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_playlist_folder_items_playlist ON playlist_folder_items(playlist_id)`, mustSucceed: true },
];
