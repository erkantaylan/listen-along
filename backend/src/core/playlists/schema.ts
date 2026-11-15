// Playlists (table `lobbies`, internally still "lobby"), the per-user
// sidebar pins and the per-user sidebar folders (folders.ts). Run by
// shared/db.ts, in the order of its SCHEMA list.
// Of the code, only the folders live here so far; lobby.js, playlistAccess.js
// and playlistPins.js move into this folder with the core.
import type { Migration } from '../../shared/db.ts';

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
  // Per-user playlist pins (playlistPins.js). Goes with both the user and the
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
  // The personal-playlist feature was removed; drop its tables so existing
  // deployments are cleaned up (CASCADE also clears playlist_songs).
  // NOTE for the lobby -> playlist rename: this drops any table named
  // `playlists` on every boot; it must go (or change) before `lobbies` is
  // renamed to `playlists`.
  `DROP TABLE IF EXISTS playlist_songs, playlists CASCADE`,

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
