// Each playlist's queue (queue.ts). Run by shared/db.ts, in the order of its
// SCHEMA list.
import type { Migration } from '../../shared/db.ts';

export const tables: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS queue_songs (
      id UUID PRIMARY KEY,
      playlist_id VARCHAR(8) NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT DEFAULT 'Unknown',
      duration REAL DEFAULT 0,
      added_by VARCHAR(255) DEFAULT 'anonymous',
      thumbnail TEXT,
      added_at BIGINT NOT NULL,
      sort_order INTEGER NOT NULL
    )
  `,
];

export const migrations: readonly Migration[] = [
  { sql: `CREATE INDEX IF NOT EXISTS idx_queue_songs_playlist ON queue_songs(playlist_id, sort_order);`, mustSucceed: true },
];
