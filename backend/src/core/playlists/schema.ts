// Playlists (table `lobbies`: the old name stays in storage), the per-user
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
];

export const tables: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS lobbies (
      id VARCHAR(8) PRIMARY KEY,
      host_id VARCHAR(255),
      name VARCHAR(50),
      visibility VARCHAR(10) NOT NULL DEFAULT 'public',
      created_at BIGINT NOT NULL,
      last_activity BIGINT NOT NULL
    )
  `,
  // Per-user playlist pins (core/playlists/playlistPins.ts). Goes with both the user and the
  // playlist. Unrelated to the shared lobbies.pinned column.
  `
    CREATE TABLE IF NOT EXISTS playlist_pins (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lobby_id VARCHAR(8) NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      pinned_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, lobby_id)
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
      lobby_id VARCHAR(8) NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      folder_id UUID NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, lobby_id),
      FOREIGN KEY (folder_id, user_id) REFERENCES playlist_folders(id, user_id) ON DELETE CASCADE
    )
  `,
];

export const migrations: readonly Migration[] = [
  // (The personal-playlist feature's tables: see `before`.)
  { sql: `CREATE INDEX IF NOT EXISTS idx_lobbies_last_activity ON lobbies(last_activity);`, mustSucceed: true },

  // Migrations for existing databases
  `
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS name VARCHAR(50)
  `,

  `
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE
  `,

  // "Jam" (synchronized) lobbies were removed: every lobby is a shared queue
  // each listener plays at their own pace. Drop the per-lobby mode, the shared
  // queue cursor and the server-side playback state so existing deployments
  // load every lobby (including former Jam ones) the same way.
  `ALTER TABLE lobbies DROP COLUMN IF EXISTS listening_mode`,
  `ALTER TABLE lobbies DROP COLUMN IF EXISTS current_index`,
  `DROP TABLE IF EXISTS playback_state`,

  // Playlists (lobbies) are 'public' or 'private' (owner only). Replaces the
  // earlier is_public flag: a lobby that was already private AND has an owner
  // stays private, everything else (including ownerless rows, which can never
  // be private) becomes public. Idempotent: the backfill only runs while the
  // old column still exists, and drops it afterwards.
  `
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS visibility VARCHAR(10) NOT NULL DEFAULT 'public'
  `,
  async (db) => {
    const legacyVisibility = await db.query(`
      SELECT 1 FROM information_schema.columns WHERE table_name = 'lobbies' AND column_name = 'is_public'
    `).catch(() => ({ rows: [] }));
    if (legacyVisibility.rows.length > 0) {
      await db.query(`
        UPDATE lobbies SET visibility = 'private' WHERE is_public = FALSE AND host_id IS NOT NULL
      `);
      await db.query(`ALTER TABLE lobbies DROP COLUMN IF EXISTS is_public`);
    }
  },

  { sql: `CREATE INDEX IF NOT EXISTS idx_playlist_pins_lobby ON playlist_pins(lobby_id)`, mustSucceed: true },

  // Playlist folders: a user's folders, a folder's playlists, and the cascade from a deleted playlist.
  { sql: `CREATE INDEX IF NOT EXISTS idx_playlist_folders_user ON playlist_folders(user_id)`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_playlist_folder_items_folder ON playlist_folder_items(folder_id)`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_playlist_folder_items_lobby ON playlist_folder_items(lobby_id)`, mustSucceed: true },
];
